export function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").toLowerCase().replace(/\p{Mn}/gu, "").replace(/\s+/g, " ").trim();
}
