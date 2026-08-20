import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const patchFile = path.join(repoRoot, "patches", "patch-manifest.json");
const stateRoot = path.join(repoRoot, "state");
const stateFile = path.join(stateRoot, "install-manifest.json");

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function gamePathArgument() {
  const index = process.argv.indexOf("--game");
  return index >= 0 ? process.argv[index + 1] : null;
}

function findGameRoot() {
  const explicit = gamePathArgument();
  const candidates = explicit
    ? [explicit]
    : [process.cwd(), repoRoot, path.dirname(repoRoot)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (fs.existsSync(path.join(resolved, "Game.exe"))) return resolved;
  }
  throw new Error("ไม่พบ Game.exe โปรดใช้ install.ps1 -GamePath <โฟลเดอร์เกม>");
}

function inside(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`เส้นทางอยู่นอกโฟลเดอร์เกม: ${relative}`);
  }
  return target;
}

function getAt(root, objectPath) {
  let value = root;
  for (const key of objectPath) value = value[key];
  return value;
}

function setAt(root, objectPath, value) {
  const parent = getAt(root, objectPath.slice(0, -1));
  parent[objectPath.at(-1)] = value;
}

function applyAchievementStage(text, stage) {
  const start = text.indexOf("//@Steam実績系のテキスト");
  const end = text.indexOf("//@クレジットのテキスト");
  if (start < 0 || end <= start) throw new Error("ไม่พบส่วนข้อความ Achievement");
  const entries = new Map(stage.entries.map(entry => [entry.id, entry]));
  const lines = text.slice(start, end).split(/\r?\n/);
  let currentId = null;
  let translated = 0;
  let generic = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = lines[index].match(/if \(data == (\d+) \|\|/);
    if (idMatch) currentId = Number(idMatch[1]);
    const indent = lines[index].match(/^\s*/)?.[0] ?? "";
    if (lines[index].includes('case "eng": return "Achieved ')) {
      lines[index] = `${indent}case "eng": return "${stage.generic.unlocked} \\"" + sub1 + "\\" แล้ว!";`;
      generic += 1;
    } else if (lines[index].includes('case "eng": return "Accomplished!";')) {
      lines[index] = `${indent}case "eng": return ${JSON.stringify(stage.generic.accomplished)};`;
      generic += 1;
    } else if (currentId !== null && lines[index].includes('case "eng": return {')) {
      const entry = entries.get(currentId);
      if (!entry) throw new Error(`ไม่มีคำแปล Achievement หมายเลข ${currentId}`);
      lines[index] = `${indent}case "eng": return { name: ${JSON.stringify(entry.name)}, text: ${JSON.stringify(entry.text)} };`;
      currentId = null;
      translated += 1;
    }
  }
  if (translated !== stage.entries.length || generic !== 2) {
    throw new Error(`แปล Achievement ไม่ครบ (${translated}/${stage.entries.length})`);
  }
  return text.slice(0, start) + lines.join("\r\n") + text.slice(end);
}

function buildOutput(gameRoot, spec) {
  const target = inside(gameRoot, spec.path);
  const original = fs.readFileSync(target, "utf8");
  if (spec.kind === "json") {
    const data = JSON.parse(original);
    for (const stage of spec.stages) {
      for (const operation of stage.operations ?? []) {
        if (operation.op === "set") setAt(data, operation.objectPath, operation.value);
      }
    }
    for (const stage of spec.stages) {
      const splices = (stage.operations ?? [])
        .filter(operation => operation.op === "spliceMessage")
        .sort((left, right) => {
          const pathOrder = JSON.stringify(left.listPath).localeCompare(JSON.stringify(right.listPath));
          return pathOrder || right.commandIndex - left.commandIndex;
        });
      for (const operation of splices) {
        const list = getAt(data, operation.listPath);
        const command = list[operation.commandIndex];
        if (command?.code !== 101 || String(command.parameters?.[4] ?? "") !== operation.sourceTag) {
          throw new Error(`ตำแหน่งบทพูดเปลี่ยนไป: ${spec.path} @ ${operation.commandIndex}`);
        }
        const indent = list[operation.commandIndex + 1]?.indent ?? command.indent ?? 0;
        const commands = operation.lines.map(line => ({ code: 401, indent, parameters: [line] }));
        list.splice(operation.commandIndex + 1, operation.sourceLineCount, ...commands);
      }
    }
    return JSON.stringify(data) + "\n";
  }

  let output = original;
  for (const stage of spec.stages) {
    if (stage.type === "replaceRanges") {
      const operations = [...stage.operations].sort((left, right) => right.start - left.start);
      for (const operation of operations) {
        if (operation.start < 0 || operation.end < operation.start || operation.end > output.length) {
          throw new Error(`ช่วงข้อความไม่ถูกต้อง: ${spec.path}`);
        }
        output = output.slice(0, operation.start) + operation.value + output.slice(operation.end);
      }
    } else if (stage.type === "achievements") {
      output = applyAchievementStage(output, stage);
    }
  }
  new vm.Script(output, { filename: spec.path });
  return output;
}

function restoreWritten(gameRoot, backupRoot, written) {
  for (const item of written.reverse()) {
    fs.copyFileSync(path.join(backupRoot, item.backupFile), inside(gameRoot, item.path));
  }
}

const patch = JSON.parse(fs.readFileSync(patchFile, "utf8"));
const gameRoot = findGameRoot();

if (fs.existsSync(stateFile)) {
  const installed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  throw new Error(`ม็อดเวอร์ชัน ${installed.modVersion} ติดตั้งอยู่แล้ว กรุณาถอนก่อนติดตั้งใหม่`);
}

for (const spec of patch.files) {
  const target = inside(gameRoot, spec.path);
  if (!fs.existsSync(target)) throw new Error(`ไม่พบไฟล์เกม: ${spec.path}`);
  const currentHash = sha256File(target);
  if (currentHash !== spec.originalSha256) {
    throw new Error(`เวอร์ชันไฟล์ไม่ตรงหรือถูกแก้ไขแล้ว: ${spec.path}\nคาดหวัง ${spec.originalSha256}\nพบ      ${currentHash}`);
  }
}

const outputs = new Map();
for (const spec of patch.files) {
  const output = buildOutput(gameRoot, spec);
  const outputHash = sha256Buffer(Buffer.from(output, "utf8"));
  if (outputHash !== spec.patchedSha256) {
    throw new Error(`ผลลัพธ์ไม่ตรง manifest: ${spec.path}`);
  }
  outputs.set(spec.path, output);
}

for (const asset of patch.assets ?? []) {
  const source = inside(repoRoot, asset.source);
  if (!fs.existsSync(source) || sha256File(source) !== asset.sha256) {
    throw new Error(`ไฟล์ประกอบสูญหายหรือเสียหาย: ${asset.source}`);
  }
}

const backupRoot = path.join(stateRoot, "backups", timestamp());
fs.mkdirSync(backupRoot, { recursive: true });
const installedFiles = [];
for (const spec of patch.files) {
  const backupFile = spec.path.replaceAll("/", "__").replaceAll("\\", "__");
  fs.copyFileSync(inside(gameRoot, spec.path), path.join(backupRoot, backupFile));
  installedFiles.push({ path: spec.path, backupFile, originalSha256: spec.originalSha256, patchedSha256: spec.patchedSha256 });
}

const assetState = [];
const written = [];
try {
  for (const spec of patch.files) {
    fs.writeFileSync(inside(gameRoot, spec.path), outputs.get(spec.path), "utf8");
    written.push(installedFiles.find(item => item.path === spec.path));
  }
  for (const asset of patch.assets ?? []) {
    const source = inside(repoRoot, asset.source);
    const target = inside(gameRoot, asset.target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
      assetState.push({ target: asset.target, action: "remove", installedSha256: asset.sha256 });
    } else if (sha256File(target) === asset.sha256) {
      assetState.push({ target: asset.target, action: "preserve", installedSha256: asset.sha256 });
    } else {
      const backupFile = `asset__${path.basename(asset.target)}`;
      fs.copyFileSync(target, path.join(backupRoot, backupFile));
      fs.copyFileSync(source, target);
      assetState.push({ target: asset.target, action: "restore", backupFile, installedSha256: asset.sha256 });
    }
  }
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    formatVersion: 1,
    modVersion: patch.modVersion,
    installedAt: new Date().toISOString(),
    gameRoot,
    backupRoot: path.relative(stateRoot, backupRoot).replaceAll(path.sep, "/"),
    files: installedFiles,
    assets: assetState
  }, null, 2) + "\n", "utf8");
} catch (error) {
  restoreWritten(gameRoot, backupRoot, written);
  throw error;
}

console.log(`ติดตั้งม็อดภาษาไทยเวอร์ชัน ${patch.modVersion} สำเร็จ`);
console.log(`แก้ไขไฟล์เกม ${patch.files.length} ไฟล์ และสำรองไว้ที่ ${backupRoot}`);
console.log("เปิดเกมแล้วเลือกภาษา English เพื่อใช้งานภาษาไทย");
