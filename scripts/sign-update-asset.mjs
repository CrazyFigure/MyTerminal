// 用项目锁定的 Tauri CLI 签名，上传前确认公钥、签名和 Release 文件名匹配。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [asset] = process.argv.slice(2);
const updatePublicKey = process.env.MYTERMINAL_UPDATE_PUBLIC_KEY;
if (!asset || !updatePublicKey || !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error('缺少更新包路径、公钥或签名私钥');
}

// 空密码需要显式传入，避免发布进程等待终端输入。非空密码始终从环境变量读取。
const args = ['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign'];
if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) args.push('--password', '');
// 签名工具原始输出可能含敏感值，失败只记录附件名。
const result = spawnSync(process.execPath, [...args, asset], { stdio: 'ignore' });
if (result.error || result.status !== 0) throw new Error(`无法签名 ${basename(asset)}`);

const decodeLines = (encoded) => Buffer.from(encoded.trim(), 'base64').toString('utf8').split(/\r?\n/);
const [, encodedKey] = decodeLines(updatePublicKey);
const [, encodedSignature, trustedComment] = decodeLines(readFileSync(`${asset}.sig`, 'utf8'));
const key = Buffer.from(encodedKey ?? '', 'base64');
const signature = Buffer.from(encodedSignature ?? '', 'base64');
// Minisign 编码跳过 2 字节算法编号后，比较 8 字节密钥 ID。
if (key.length !== 42 || signature.length !== 74 || !key.subarray(2, 10).equals(signature.subarray(2, 10))) {
  throw new Error('更新公钥与安装包签名的密钥 ID 不匹配');
}
if (!trustedComment?.split('\t').includes(`file:${basename(asset)}`)) {
  throw new Error('更新签名未绑定当前发布文件名');
}
