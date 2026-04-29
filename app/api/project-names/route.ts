import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

const PROJECT_NAMES_PATH = path.join(process.cwd(), "project-names.json");

async function readProjectNames(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(PROJECT_NAMES_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => typeof key === "string" && typeof value === "string"
      )
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { projectId?: string; name?: string };
    const projectId = body.projectId?.trim();
    const name = body.name?.trim();

    if (!projectId) {
      return NextResponse.json({ message: "Missing projectId." }, { status: 400 });
    }

    if (!name) {
      return NextResponse.json({ message: "Missing name." }, { status: 400 });
    }

    const current = await readProjectNames();
    current[projectId] = name;
    await fs.writeFile(PROJECT_NAMES_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");

    return NextResponse.json({ ok: true, projectId, name });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Unable to save project name." },
      { status: 500 }
    );
  }
}
