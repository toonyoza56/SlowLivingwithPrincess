import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const stateRoot = path.join(repoRoot, "state");
const stateFile = path.join(stateRoot, "install-manifest.json");

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function inside(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(prefix)) throw new Error(`เส้นทางไม่ปลอดภัย: ${relative}`);
  return target;
}

if (!fs.existsSync(stateFile)) {
  console.log("ไม่พบข้อมูลการติดตั้ง ม็อดอาจถูกถอนไปแล้ว");
  process.exit(0);
}

const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const gameRoot = path.resolve(argument("--game") ?? state.gameRoot);
const force = process.argv.includes("--force");
const backupRoot = path.join(stateRoot, state.backupRoot);

for (const item of state.files) {
  const target = inside(gameRoot, item.path);
  const backup = path.join(backupRoot, item.backupFile);
  if (!fs.existsSync(backup) || sha256File(backup) !== item.originalSha256) {
    throw new Error(`ไฟล์สำรองสูญหายหรือเสียหาย: ${item.backupFile}`);
  }
  if (fs.existsSync(target)) {
    const current = sha256File(target);
    if (!force && current !== item.patchedSha256 && current !== item.originalSha256) {
      throw new Error(`ไฟล์ถูกแก้หลังติดตั้ง: ${item.path}\nใช้ uninstall.ps1 -Force หากต้องการคืนไฟล์เดิมทับ`);
    }
  }
}

for (const item of state.files) {
  fs.copyFileSync(path.join(backupRoot, item.backupFile), inside(gameRoot, item.path));
}

for (const asset of state.assets ?? []) {
  const target = inside(gameRoot, asset.target);
  if (asset.action === "remove") {
    if (fs.existsSync(target) && (force || sha256File(target) === asset.installedSha256)) fs.unlinkSync(target);
  } else if (asset.action === "restore") {
    fs.copyFileSync(path.join(backupRoot, asset.backupFile), target);
  }
}

fs.unlinkSync(stateFile);
console.log(`ถอนม็อดภาษาไทยเวอร์ชัน ${state.modVersion} สำเร็จ`);
console.log(`คืนไฟล์เกมเดิม ${state.files.length} ไฟล์แล้ว`);
console.log(`ไฟล์สำรองยังเก็บอยู่ที่ ${backupRoot}`);
