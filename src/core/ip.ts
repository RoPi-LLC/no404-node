/**
 * IP address helpers without `node:net` (the core must run on Workers too).
 * Parsing is strict: anything PHP's `filter_var(FILTER_VALIDATE_IP)` would
 * reject is rejected here as well, so every integration drops the same input.
 */

export interface ParsedIp {
  version: 4 | 6;
  bytes: Uint8Array<ArrayBuffer>;
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function parseIPv4(input: string): Uint8Array<ArrayBuffer> | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(input);
  if (!match) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = match[i + 1] ?? "";
    // "01" is octal in some parsers; refuse the ambiguity.
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

export function parseIPv6(input: string): Uint8Array<ArrayBuffer> | null {
  if (!input.includes(":") || /[^0-9a-fA-F:.]/.test(input)) return null;
  const halves = input.split("::");
  if (halves.length > 2) return null;
  // An embedded IPv4 may only end the address.
  if (halves.length === 2 && (halves[0] ?? "").includes(".")) return null;

  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const items = part.split(":");
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? "";
      if (item.includes(".")) {
        if (i !== items.length - 1) return null;
        const v4 = parseIPv4(item);
        if (!v4) return null;
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return null;
        out.push(Number.parseInt(item, 16));
      }
    }
    return out;
  };

  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** Parses an address; the IPv4-mapped IPv6 spelling (`::ffff:1.2.3.4`) counts as IPv4. */
export function parseIp(raw: unknown): ParsedIp | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  const mapped = MAPPED_V4.exec(value);
  if (mapped) value = mapped[1] ?? "";

  const v4 = parseIPv4(value);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = parseIPv6(value);
  if (v6) return { version: 6, bytes: v6 };
  return null;
}

/** RFC 5952 text form: lower case, no leading zeros, the longest zero run (≥ 2 groups) as "::". */
export function formatIPv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));

  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }

  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/**
 * Truncates an address to its network: IPv4 → last octet zeroed (203.0.113.0),
 * IPv6 → first 48 bits (2001:db8:1c1c::). Invalid input → "".
 */
export function truncateIp(raw: unknown): string {
  const ip = parseIp(raw);
  if (!ip) return "";
  if (ip.version === 4) return `${ip.bytes[0]}.${ip.bytes[1]}.${ip.bytes[2]}.0`;
  const network = new Uint8Array(16);
  network.set(ip.bytes.subarray(0, 6));
  return formatIPv6(network);
}

/**
 * Is this a public address? Private, loopback, link-local, CGNAT, documentation,
 * multicast and reserved ranges are never sent to no404 as a visitor IP.
 */
export function isPublicIp(raw: unknown): boolean {
  const ip = parseIp(raw);
  if (!ip) return false;
  const b = ip.bytes;
  const [a = 0, second = 0, third = 0] = b;

  if (ip.version === 4) {
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && second >= 64 && second <= 127) return false; // 100.64/10 CGNAT
    if (a === 169 && second === 254) return false;
    if (a === 172 && second >= 16 && second <= 31) return false;
    if (a === 192 && second === 168) return false;
    if (a === 192 && second === 0 && (third === 0 || third === 2)) return false;
    if (a === 198 && (second === 18 || second === 19)) return false;
    if (a === 198 && second === 51 && third === 100) return false;
    if (a === 203 && second === 0 && third === 113) return false;
    if (a >= 224) return false; // multicast + 240/4 reserved
    return true;
  }

  if (b.every((byte) => byte === 0)) return false; // ::
  if (b.subarray(0, 15).every((byte) => byte === 0) && b[15] === 1) return false; // ::1
  if ((a & 0xfe) === 0xfc) return false; // fc00::/7 unique local
  if (a === 0xfe && (second & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (a === 0xff) return false; // multicast
  if (a === 0x20 && second === 0x01 && third === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32
  return true;
}
