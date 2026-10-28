// Append-only JSONL writer. Lines are never mutated, each write is fsync'd.
// These logs are the source of truth for events (chat door) and traces; graph rows derived
// from them are rebuilt from the log at boot, which is how the substrate stays inspectable.
import fs from "node:fs";
import path from "node:path";

export class JsonlLog {
  private fd: number | null = null;
  private count = 0;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, "a");
    this.count = this.readAll().length;
  }

  /** Append one record. fsync per write — durability is not optional. */
  append(record: Record<string, any>): number {
    if (this.fd === null) throw new Error(`log closed: ${this.file}`);
    const line = JSON.stringify(record) + "\n";
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
    this.count++;
    return this.count;
  }

  readAll(): any[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, "utf8");
    const out: any[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // A torn line can only be the tail of an interrupted write; keep the rest.
      }
    }
    return out;
  }

  get size(): number {
    return this.count;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
