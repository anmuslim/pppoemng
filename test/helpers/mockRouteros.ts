import net from 'net';
import crypto from 'crypto';
import { encodeSentence, SentenceParser } from '../../server/drivers/rosClient.js';

type Row = Record<string, string>;

export interface MockOptions {
  user?: string;
  password?: string;
  /** Meniru RouterOS < 6.43 (challenge-response). */
  legacyLogin?: boolean;
  /** Meniru RouterOS >= 7.18: kirim !empty untuk hasil kosong. */
  emptyReply?: boolean;
  /** Kirim balasan sepotong-sepotong (menguji parser stream). */
  chunked?: boolean;
  /** Perintah yang tidak pernah dibalas (menguji timeout). */
  hang?: string[];
  tables?: Record<string, Row[]>;
}

export interface MockRouteros {
  port: number;
  tables: Record<string, Row[]>;
  stats: { connections: number; commands: string[]; logins: number; openNow: number };
  close(): Promise<void>;
  dropAll(): void;
}

export async function startMockRouteros(opts: MockOptions = {}): Promise<MockRouteros> {
  const user = opts.user ?? 'api';
  const password = opts.password ?? 'secret';
  const tables: Record<string, Row[]> = opts.tables ?? {};
  let idSeq = 1000;
  const stats = { connections: 0, commands: [] as string[], logins: 0, openNow: 0 };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    stats.connections++;
    stats.openNow++;
    sockets.add(socket);
    socket.on('close', () => {
      stats.openNow--;
      sockets.delete(socket);
    });
    socket.on('error', () => undefined);

    const parser = new SentenceParser();
    let challenge = '';
    let loggedIn = false;

    const send = (sentences: string[][]) => {
      const buf = Buffer.concat(sentences.map(encodeSentence));
      if (!opts.chunked) return void socket.write(buf);
      let i = 0;
      const step = () => {
        if (i >= buf.length || socket.destroyed) return;
        const n = 1 + Math.floor(Math.random() * 7);
        socket.write(buf.subarray(i, i + n));
        i += n;
        setImmediate(step);
      };
      step();
    };

    const rowsToSentences = (rows: Row[]): string[][] => {
      const out: string[][] = rows.map((r) => ['!re', ...Object.entries(r).map(([k, v]) => `=${k}=${v}`)]);
      if (rows.length === 0 && opts.emptyReply) out.push(['!empty']);
      return out;
    };

    const handle = (words: string[]) => {
      const cmd = words[0];
      const attrs: Record<string, string> = {};
      const queries: Record<string, string> = {};
      for (const w of words.slice(1)) {
        if (w.startsWith('=')) {
          const i = w.indexOf('=', 1);
          attrs[w.slice(1, i)] = w.slice(i + 1);
        } else if (w.startsWith('?')) {
          const i = w.indexOf('=');
          queries[w.slice(1, i)] = w.slice(i + 1);
        }
      }

      if (cmd === '/quit') return void socket.end();

      if (cmd === '/login') {
        stats.logins++;
        if (opts.legacyLogin && !attrs.response) {
          challenge = crypto.randomBytes(16).toString('hex');
          return send([['!done', `=ret=${challenge}`]]);
        }
        let ok = false;
        if (attrs.response) {
          const md5 = crypto.createHash('md5');
          md5.update(Buffer.from([0]));
          md5.update(password, 'utf8');
          md5.update(Buffer.from(challenge, 'hex'));
          ok = attrs.name === user && attrs.response === `00${md5.digest('hex')}`;
        } else {
          ok = attrs.name === user && attrs.password === password;
        }
        if (!ok) return send([['!trap', '=message=cannot log in'], ['!done']]);
        loggedIn = true;
        return send([['!done']]);
      }

      if (!loggedIn) return send([['!fatal', 'not logged in']]);
      stats.commands.push(cmd);
      if (opts.hang?.some((h) => cmd.startsWith(h))) return; // tidak dibalas

      const m = /^(\/.+)\/(print|add|set|remove|enable|disable)$/.exec(cmd);
      if (cmd === '/system/resource/print') {
        return send([
          ['!re', '=version=7.18 (stable)', '=uptime=1d2h', '=cpu-load=7', '=free-memory=536870912', '=total-memory=1073741824', '=board-name=RB4011'],
          ['!done'],
        ]);
      }
      if (cmd === '/system/identity/print') return send([['!re', '=name=Mock-Router'], ['!done']]);
      if (cmd === '/interface/monitor-traffic') return send([['!re', '=rx-bits-per-second=1000000', '=tx-bits-per-second=5000000'], ['!done']]);
      if (cmd === '/ping') {
        const n = Number(attrs.count || 1);
        const rows: string[][] = [];
        for (let i = 0; i < n; i++) rows.push(['!re', `=host=${attrs.address}`, '=size=32', '=ttl=64', '=time=3ms']);
        return send([...rows, ['!done']]);
      }
      if (!m) return send([['!trap', '=message=no such command'], ['!done']]);

      const [, path, verb] = m;
      const table = (tables[path] ||= []);

      if (verb === 'print') {
        let rows = table.filter((r) => Object.entries(queries).every(([k, v]) => r[k] === v));
        if (attrs['.proplist']) {
          const keep = new Set(['.id', ...attrs['.proplist'].split(',')]);
          rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
        }
        return send([...rowsToSentences(rows), ['!done']]);
      }
      if (verb === 'add') {
        if (attrs.name && table.some((r) => r.name === attrs.name)) {
          return send([['!trap', '=message=failure: already have such entry'], ['!done']]);
        }
        const id = `*${(idSeq++).toString(16)}`;
        table.push({ '.id': id, ...attrs });
        return send([['!done', `=ret=${id}`]]);
      }
      const row = table.find((r) => r['.id'] === attrs['.id']);
      if (!row) return send([['!trap', '=message=no such item'], ['!done']]);
      if (verb === 'remove') table.splice(table.indexOf(row), 1);
      else if (verb === 'disable') row.disabled = 'true';
      else if (verb === 'enable') row.disabled = 'false';
      else for (const [k, v] of Object.entries(attrs)) if (k !== '.id') row[k] = v;
      return send([['!done']]);
    };

    socket.on('data', (chunk) => {
      for (const words of parser.push(chunk)) handle(words);
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    tables,
    stats,
    dropAll: () => sockets.forEach((s) => s.destroy()),
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
      }),
  };
}
