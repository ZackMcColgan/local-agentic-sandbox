import { NextResponse } from "next/server";
import {
  getProject,
  toggleAllowlist,
  deleteProject,
  updateProject
} from "@/lib/projects/projectStore";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { id } = await Promise.resolve(params);
    const project = getProject(id);
    if (!project) {
      return NextResponse.json({ error: `Project not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json({ project });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const { id } = await Promise.resolve(params);
    const body = await req.json().catch(() => ({}));

    if (body.allowlisted !== undefined && typeof body.allowlisted === "boolean") {
      const project = toggleAllowlist(id, body.allowlisted);
      return NextResponse.json({ project });
    }

    const project = updateProject(id, body);
    return NextResponse.json({ project });
  } catch (err: any) {
    if (err.message && /not found/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { id } = await Promise.resolve(params);
    const success = deleteProject(id);
    if (!success) {
      return NextResponse.json({ error: `Project not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
