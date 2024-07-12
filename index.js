const FS = require('fs');
const PATH = require('path');
const ADMZIP = require('adm-zip');
const MD5 = require('md5');
const SQLITE = require('sqlite3').verbose();
const TAR = require('tar');


function getFileId(filePath) {
    const md5 = MD5(FS.readFileSync(filePath));

    let result = '';
    for (let i = 0; i < md5.length; i += 2) {
        result += md5[i];
    }
    return 'FM' + result.toUpperCase();
}

class Billfish {
    rootPath;
    db;

    constructor(dbPath) {
        this.rootPath = PATH.join(PATH.dirname(dbPath), '..');


        this.db = new SQLITE.Database(dbPath, e => {
            if (e) {
                console.log('[ERR ] 读取数据库失败', e);
                process.exit(0);
            }
        });
    }


    getFiles = () => new Promise((resolve, reject) => {
        this.db.all('SELECT * FROM bf_file', (e, rows) => {
            if (e) reject(e);
            else resolve(rows);
        });
    });

    findFile(fileName, dir) {
        if (!dir) dir = this.rootPath;
        const files = FS.readdirSync(dir);

        for (const i of files) {
            if (i === '.bf') continue;

            const fullPath = PATH.join(dir, i);
            const stat = FS.statSync(fullPath);

            if (stat.isDirectory()) {
                const result = this.findFile(fileName, fullPath);
                if (result) return result;
            } else if (i === fileName) {
                return fullPath;
            }
        }

        return null;
    }

    getExtNameById = extId => new Promise((resolve, reject) => {
        this.db.get('SELECT * FROM bf_type WHERE tid = ?', [extId], (e, row) => {
            if (e) reject(e);
            else resolve(row.name);
        });
    });

    getUserDataByFid = fileId => new Promise((resolve, reject) => {
        this.db.get('SELECT * FROM bf_material_userdata WHERE file_id = ?', [fileId], (e, row) => {
            if (e) reject(e);
            else resolve(row);
        });
    });

    getTagsByFileId = fileId => new Promise((resolve, reject) => {
        this.db.all('SELECT * FROM bf_tag_join_file WHERE file_id = ?', [fileId], (e, rows) => {
            if (e) reject(e);
            else {
                const promises = rows.map(i => bf.getTagNameById(i.tag_id));
                Promise.all(promises).then(resolve).catch(reject);
            }
        });
    });

    getTagNameById = tagId => new Promise((resolve, reject) => {
        this.db.get('SELECT * FROM bf_tag_v2 WHERE id = ?', [tagId], (e, row) => {
            if (e) reject(e);
            else resolve(row.name);
        });
    });

    close = () => new Promise((resolve, reject) => {
        this.db.close(e => {
            if (e) reject(e);
            else {
                this.db = null;
                resolve();
            }
        });
    });

    getWHByFileId = fileId => new Promise((resolve, reject) => {
        this.db.get('SELECT * FROM bf_material_v2 WHERE file_id = ?', [fileId], (e, row) => {
            if (e) reject(e);
            else resolve({
                width: row.w,
                height: row.h
            });
        });
    });
}

function removeExt(str) {
    const index = str.lastIndexOf('.');
    return index === -1 ? str : str.substring(0, index);
}


console.log(`
  ____  _ _ _  __ _     _  _______    _      _              ____
 |  _ \\(_) | |/ _(_)   | ||__   __|  | |    (_)            / __ \\
 | |_) |_| | | |_ _ ___| |__ | | ___ | |     _ _ __   __ _| |  | |_   _  __ _ _ __
 |  _ <| | | |  _| / __| '_ \\| |/ _ \\| |    | | '_ \\ / _\` | |  | | | | |/ _\` | '_ \\
 | |_) | | | | | | \\__ \\ | | | | (_) | |____| | | | | (_| | |__| | |_| | (_| | | | |
 |____/|_|_|_|_| |_|___/_| |_|_|\\___/|______|_|_| |_|\\__, |\\___\\_\\\\__,_|\\__,_|_| |_|
                                                      __/ |
                                                     |___/
`);
console.log('[WARN] 测试使用的 Billfish 版本为 v3.0.33.8，测试使用的零泉版本为 v1.1.2，如果你的版本不匹配，请先备份\n');


// 0. 检查 `input.BillfishPack`、`temp` 和 `output.lqpack` 是否存在
if (!FS.existsSync(PATH.join(__dirname, 'input.BillfishPack'))) {
    console.log('[Tips] 将你的文件导出为 `<name>.BillfishPack`，然后将它重命名为 `input.BillfishPack`，放到工具根目录下，重新运行即可');
    process.exit(0);
}
if (FS.existsSync(PATH.join(__dirname, 'temp'))) {
    console.log('[ERR ] 存在临时目录，请手动删除 temp 文件夹后重新运行');
    process.exit(0);
}
if (FS.existsSync(PATH.join(__dirname, 'output.lqpack'))) {
    console.log('[ERR ] `output.lqpack` 已存在，请删除后重新运行');
    process.exit(0);
}

FS.mkdirSync(PATH.join(__dirname, 'temp'));
FS.mkdirSync(PATH.join(__dirname, 'temp', 'unzip'));
FS.mkdirSync(PATH.join(__dirname, 'temp', 'work'));
FS.mkdirSync(PATH.join(__dirname, 'temp', 'work', 'output.lingquan')); // 没有这个会不识别

// 先解压
console.log('[INFO] 解压...');
const zip = new ADMZIP(PATH.join(__dirname, 'input.BillfishPack'));
zip.extractAllTo(PATH.join(__dirname, 'temp', 'unzip'), true);
console.log('[INFO] 解压完成');


// 1. 根据 billfish.db 开始搬文件
// - bf_file
// - bf_material_userdata(文件和其对应的用户信息)
// - bf_tag_v2(所有标签) || bf_tag_join_file(标签跟文件的对应关系)
// - bf_type(文件后缀)
console.log('[INFO] 开始转换...');
const bf = new Billfish(PATH.join(__dirname, 'temp', 'unzip', '.bf', 'billfish.db'));
bf.getFiles().then(async res => {
    const realWorkPath = PATH.join(__dirname, 'temp', 'work', 'output.lingquan');
    FS.mkdirSync(PATH.join(realWorkPath, 'resources'));
    FS.mkdirSync(PATH.join(realWorkPath, 'materialPackage')); // 没有这个会不识别

    for (const i of res) {
        const filePath = bf.findFile(i.name);
        if (!filePath) {
            console.log(`[ERR ] 无法找到 "${i.name}"，已跳过`);
            continue;
        }

        const id = getFileId(filePath);
        if (FS.existsSync(PATH.join(realWorkPath, 'resources', id))) {
            console.log(`[INFO]   已跳过 "${i.name}"`);
            continue;
        }

        const WH = await bf.getWHByFileId(i.id);

        const info = {
            id,
            hashId: '',
            name: removeExt(i.name),
            ext: await bf.getExtNameById(i.tid),
            width: WH.width,
            height: WH.height,
            size: null,
            score: await bf.getUserDataByFid(id).score,
            time: i.ctime, // createAt
            revisionTime: i.mtime,
            tags: await bf.getTagsByFileId(i.id),
            folders: null,
            note: await bf.getUserDataByFid(id).note,
            url: await bf.getUserDataByFid(id).origin,
            palettes: null,
            delete: null,
            usnIndex: null,
            comments: null,
            author: null,
            prompt: null
        }

        const path = PATH.join(realWorkPath, 'resources', id);
        FS.mkdirSync(path);
        FS.copyFileSync(filePath, PATH.join(path, i.name));
        FS.writeFileSync(PATH.join(path, '__info.json'), JSON.stringify(info));

        console.log(`[INFO]   已完成 "${i.name}"`);
    }

    await bf.close();

    console.log('[INFO] 压缩...');
    await TAR.c({
        gzip: true,
        file: PATH.join(__dirname, 'output.lqpack'),
        cwd: PATH.join(__dirname, 'temp', 'work'),
    }, ['.']);
    console.log('[INFO] 压缩完成');

    console.log('[INFO] 删除临时文件...');
    FS.rmSync(PATH.join(__dirname, 'temp'), { recursive: true });
    console.log('[INFO] 删除完成');

    console.log('[INFO] 转换完成');
});
