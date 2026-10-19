import { NextResponse } from "next/server";
import {
  listProjects,
  registerProject,
  toggleAllowlist,
  deleteProject,
  getProject
} from "@/lib/projects/projectStore";

export async function GET() {
  try {
    const projects = listProjects();
    return NextResponse.json({ projects });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { name, rootPath, baseBranch, toolchain } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    }
    if (!rootPath || typeof rootPath !== "string" || !rootPath.trim()) {
      return NextResponse.json({ error: "Project rootPath is required" }, { status: 400 });
    }

    const project = registerProject({
      name: name.trim(),
      rootPath: rootPath.trim(),
      baseBranch: baseBranch ? String(baseBranch).trim() : undefined,
      toolchain: toolchain ? String(toolchain).trim() : undefined
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (err: any) {
    if (err.message && /already registered|UNIQUE constraint/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { id, allowlisted } = body;

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Project id is required" }, { status: 400 });
    }

    const project = toggleAllowlist(id, typeof allowlisted === "boolean" ? allowlisted : undefined);
    return NextResponse.json({ project });
  } catch (err: any) {
    if (err.message && /not found/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const idFromQuery = url.searchParams.get("id");
    let id = idFromQuery;

    if (!id) {
      const body = await req.json().catch(() => ({}));
      id = body.id;
    }

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Project id is required" }, { status: 400 });
    }

    const success = deleteProject(id);
    if (!success) {
      return NextResponse.json({ error: `Project not found: ${id}` }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
