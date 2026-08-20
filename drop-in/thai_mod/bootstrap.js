(() => {
  "use strict";

  function showError(error) {
    console.error("Thai mod bootstrap failed", error);
    const message = String(error?.message ?? error);
    document.body.innerHTML = `
      <div style="box-sizing:border-box;max-width:900px;margin:8vh auto;padding:28px;color:#fff;background:#211;font:20px/1.6 sans-serif;border:2px solid #d66;border-radius:12px">
        <h1 style="margin-top:0">ติดตั้งม็อดภาษาไทยไม่สำเร็จ</h1>
        <p>ไฟล์เกมอาจเป็นคนละเวอร์ชันหรือมีม็อดอื่นแก้ไขอยู่</p>
        <p>ให้ใช้ Steam ตรวจสอบความสมบูรณ์ของไฟล์เกม แล้วแตกไฟล์ม็อดทับใหม่อีกครั้ง</p>
        <pre style="white-space:pre-wrap;color:#fbb">${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>
      </div>`;
  }

  function startGame() {
    const script = document.createElement("script");
    script.src = "js/main.js";
    script.onerror = () => showError(new Error("ไม่พบ js/main.js กรุณาตรวจว่าคัดลอกม็อดไว้ในโฟลเดอร์เดียวกับ Game.exe"));
    document.body.appendChild(script);
  }

  try {
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const vm = require("vm");

    const gameRoot = process.cwd();
    const runtimeRoot = path.join(gameRoot, "thai_mod");
    const patchPath = path.join(runtimeRoot, "patch-manifest.json");
    const fontSource = path.join(runtimeRoot, "NotoSansThai-Regular.ttf");

    if (!fs.existsSync(path.join(gameRoot, "Game.exe"))) {
      throw new Error("ไม่พบ Game.exe กรุณาแตกไฟล์ทั้งหมดไว้ในโฟลเดอร์หลักของเกม");
    }
    if (!fs.existsSync(patchPath)) {
      throw new Error("ไม่พบ thai_mod/patch-manifest.json กรุณาแตกไฟล์ม็อดใหม่ให้ครบ");
    }

    const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));

    function sha256Buffer(buffer) {
      return crypto.createHash("sha256").update(buffer).digest("hex");
    }

    function sha256File(file) {
      return sha256Buffer(fs.readFileSync(file));
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
      parent[objectPath[objectPath.length - 1]] = value;
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

    function buildOutput(spec, original) {
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

    const pending = [];
    for (const spec of patch.files) {
      const target = inside(gameRoot, spec.path);
      if (!fs.existsSync(target)) throw new Error(`ไม่พบไฟล์เกม: ${spec.path}`);
      const currentHash = sha256File(target);
      if (currentHash === spec.patchedSha256) continue;
      if (currentHash !== spec.originalSha256) {
        throw new Error(`เวอร์ชันไฟล์ไม่ตรงหรือถูกแก้ไขแล้ว: ${spec.path}`);
      }
      const output = buildOutput(spec, fs.readFileSync(target, "utf8"));
      if (sha256Buffer(Buffer.from(output, "utf8")) !== spec.patchedSha256) {
        throw new Error(`ผลลัพธ์ไม่ตรง manifest: ${spec.path}`);
      }
      pending.push({ target, output });
    }

    const fontHash = patch.assets?.[0]?.sha256;
    const fontTarget = path.join(gameRoot, "fonts", "NotoSansThai-Regular.ttf");
    if (!fontHash || !fs.existsSync(fontSource) || sha256File(fontSource) !== fontHash) {
      throw new Error("ไฟล์ฟอนต์ของม็อดสูญหายหรือเสียหาย");
    }
    if (!fs.existsSync(fontTarget)) {
      fs.copyFileSync(fontSource, fontTarget);
    } else if (sha256File(fontTarget) !== fontHash) {
      throw new Error("มีไฟล์ fonts/NotoSansThai-Regular.ttf คนละเวอร์ชันอยู่แล้ว");
    }

    for (const item of pending) {
      fs.writeFileSync(item.target, item.output, "utf8");
    }

    console.log(`Thai translation mod ${patch.modVersion} ready (${pending.length} file(s) updated).`);
    startGame();
  } catch (error) {
    showError(error);
  }
})();
