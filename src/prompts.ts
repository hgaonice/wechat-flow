import fs from "node:fs";
import path from "node:path";

export function renderTemplate(file: string, vars: Record<string, string>): string {
  let text = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{{${k}}}`).join(v);
  }
  return text;
}
