import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectTree } from "../components/projects/ProjectTree";
import type { ProjectRecord } from "../lib/projects/projectStore";

const sampleProject: ProjectRecord = {
  project_id: "proj-1",
  name: "Alpha Repo",
  root_path: "/workspace/alpha",
  base_branch: "main",
  toolchain: "node:22",
  allowlisted: 1,
  active_task_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("ProjectTree characterization", () => {
  it("renders empty state when no projects are registered", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectTree, {
        projects: [],
        activeProjectId: null,
        confirmDeleteProjectId: null,
        deletingProjectId: null,
        canDelete: false,
        onOpenRegisterModal: () => {},
        onSelectProject: () => {},
        onToggleAllowlist: () => {},
        onRequestDelete: () => {},
        onCancelDelete: () => {},
        onConfirmDelete: () => {},
      })
    );
    assert.ok(html.includes("No Projects Registered"));
    assert.ok(html.includes("Register First Folder"));
  });

  it("renders project cards with selection, allowlist status, active run, and delete confirmation", () => {
    const activeProj: ProjectRecord = {
      ...sampleProject,
      project_id: "proj-2",
      name: "Beta Repo",
      allowlisted: 0,
      active_task_id: "task-99",
    };

    const html = renderToStaticMarkup(
      React.createElement(ProjectTree, {
        projects: [sampleProject, activeProj],
        activeProjectId: "proj-1",
        confirmDeleteProjectId: "proj-2",
        deletingProjectId: null,
        canDelete: true,
        onOpenRegisterModal: () => {},
        onSelectProject: () => {},
        onToggleAllowlist: () => {},
        onRequestDelete: () => {},
        onCancelDelete: () => {},
        onConfirmDelete: () => {},
      })
    );

    assert.ok(html.includes("Alpha Repo"));
    assert.ok(html.includes("Allowlisted"));
    assert.ok(html.includes("Beta Repo"));
    assert.ok(html.includes("Revoked"));
    assert.ok(html.includes("Active Run"));
    assert.ok(html.includes('data-testid="project-delete-btn-proj-1"'));
    assert.ok(html.includes('data-testid="project-delete-confirm-proj-2"'));
    assert.ok(html.includes("Confirm Delete"));
  });
});
