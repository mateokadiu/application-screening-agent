import { readFileSync } from "node:fs";
import { z } from "zod";

export interface Application {
  id: string;
  text: string;
}

const applicationsSchema = z.array(
  z.object({
    id: z.string().regex(/^[\w-]{1,64}$/, "id must be alphanumeric"),
    text: z.string().min(1).max(20_000),
  }),
);

export function loadApplications(file: string): Application[] {
  const apps = applicationsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const ids = new Set(apps.map((a) => a.id));
  if (ids.size !== apps.length) throw new Error(`Duplicate application ids in ${file}`);
  return apps;
}
