// 共享 CDP-over-WS 客户端（零依赖）
// - 等待 HTTP 101 握手完成才算连接成功（Chrome 刚启动时的关键修复）
// - 处理 ping/close 操作码、任意分片边界
// - 每个 send 带 20s 超时
export async function getBrowserWs(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`);
  const j = await r.json();
  return j.webSocketDebuggerUrl;
}

export async function ws(urlStr, { timeoutMs = 20000 } = {}) {
  const { webcrypto } = await import("node:crypto");
  const net = await import("node:net");
  const url = new URL(urlStr);
  const key = webcrypto.getRandomValues(new Uint8Array(16)).toString("base64");
  const socket = net.connect(Number(url.port), url.hostname);
  socket.setTimeout(timeoutMs);
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("error", rej); socket.once("timeout", () => rej(new Error("tcp timeout"))); });

  socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);

  let buf = Buffer.alloc(0), headerDone = false;
  const pending = new Map(); let msgId = 0; const listeners = [];
  let closed = false;

  const sendRaw = (opcode, payload) => {
    const mask = webcrypto.getRandomValues(new Uint8Array(4));
    let header;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  };

  // 等待 101 握手（在这之前任何数据都是 HTTP 头）
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("ws handshake timeout")), timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const head = buf.subarray(0, i).toString("utf8");
      socket.off("data", onData);
      clearTimeout(to);
      socket.setTimeout(0);
      if (!/^HTTP\/1\.1 101/.test(head)) {
        socket.destroy();
        rej(new Error(`ws handshake rejected: ${head.split("\r\n")[0]}`));
        return;
      }
      buf = buf.subarray(i + 4);
      headerDone = true;
      res();
    };
    socket.on("data", onData);
    socket.once("error", (e) => { clearTimeout(to); rej(e); });
  });

  socket.on("data", chunk => {
    if (closed) return;
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] >> 7) & 1;
      const lb = buf[1] & 0x7f;
      let off = 2, len = lb;
      if (lb === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (lb === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (masked) { if (buf.length < off + 4) break; maskKey = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) break;
      let p = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (maskKey) { const t2 = Buffer.from(p); for (let i = 0; i < t2.length; i++) t2[i] ^= maskKey[i % 4]; p = t2; }
      if (opcode === 0x9) { sendRaw(0xA, p); continue; }          // ping -> pong
      if (opcode === 0x8) { socket.destroy(); closed = true; break; } // close
      if (opcode === 0xA) continue;                              // pong
      if (opcode !== 0x1 && opcode !== 0x2 && opcode !== 0x0) continue;
      const t = p.toString("utf8");
      let m; try { m = JSON.parse(t); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) {
        const q = pending.get(m.id); pending.delete(m.id);
        m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
      } else listeners.forEach(l => l(m));
    }
  });

  const withTimeout = (id, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => { pending.delete(id); rej(new Error(`cdp timeout: ${id}`)); }, timeoutMs))
  ]);

  return {
    send: (method, params = {}) => {
      const id = ++msgId;
      const p = new Promise((res, rej) => { pending.set(id, { res, rej }); sendRaw(0x1, Buffer.from(JSON.stringify({ id, method, params }))); });
      return withTimeout(id, p);
    },
    sendSession: (sessionId, method, params = {}) => {
      const id = ++msgId;
      const p = new Promise((res, rej) => { pending.set(id, { res, rej }); sendRaw(0x1, Buffer.from(JSON.stringify({ id, method, params, sessionId }))); });
      return withTimeout(id, p);
    },
    on: f => listeners.push(f),
    close: () => { closed = true; socket.destroy(); }
  };
}
