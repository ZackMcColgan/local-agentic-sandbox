import { NextResponse } from "next/server";
import { getProject } from "@/lib/projects/projectStore";
import { getProjectTree, readProjectFile } from "@/lib/projects/projectGit";

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

    if (project.allowlisted !== 1) {
      return NextResponse.json(
        { error: `Project '${project.name}' is revoked. Filesystem access forbidden.` },
        { status: 403 }
      );
    }

    const url = new URL(req.url);
    const filePath = url.searchParams.get("path");

    if (filePath) {
      try {
        const fileData = readProjectFile(project, filePath);
        return NextResponse.json(fileData);
      } catch (err: any) {
        if (/forbidden|traversal|outside project root|symlink escape|revoked/i.test(err.message)) {
          return NextResponse.json({ error: err.message }, { status: 403 });
        }
        if (/not a file|no such file|does not exist/i.test(err.message) || err.code === "ENOENT") {
          return NextResponse.json({ error: `File not found: ${filePath}` }, { status: 404 });
        }
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
    }

    // Otherwise return tree
    try {
      const tree = getProjectTree(project);
      return NextResponse.json({ tree });
    } catch (err: any) {
      if (/forbidden|traversal|outside project root|symlink escape|revoked/i.test(err.message)) {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
