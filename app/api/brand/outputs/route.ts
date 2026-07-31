/**
 * Brand outputs — list + create a draft.
 *
 * POST validates the slot inputs against the template BEFORE storing anything,
 * and refuses on any error-severity issue. Validating at create rather than at
 * render is the point: an output row is a claim about what will be produced, so
 * storing one that cannot render turns a fixable input mistake into a queue of
 * broken drafts nobody can act on.
 *
 * Every output lands as `draft` regardless of who or what created it. Reaching
 * `approved` is a separate, human-gated action — see the [id] route.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getCanon } from "@/lib/brand/getCanon";
import { listAssets, type SupabaseLikeClient as AssetClient } from "@/lib/brand/assets";
import {
  getActiveSeason,
  seasonContext,
  type SupabaseLikeClient as SeasonClient,
} from "@/lib/brand/seasons";
import {
  getTemplateVersion,
  type SupabaseLikeClient as TemplateClient,
} from "@/lib/brand/templates";
import {
  collectAssetRefs,
  createOutput,
  listOutputs,
  snapshotTokens,
  type OutputStatus,
  type SupabaseLikeClient as OutputClient,
} from "@/lib/brand/outputs";
import { hasBlockingIssues, validateSlotInputs } from "@/lib/brand/validateSlots";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(CAP.brandOutputsRead);
  } catch (res) {
    return res as Response;
  }

  try {
    const params = new URL(req.url).searchParams;
    const supabase = createSupabaseAdminClient() as unknown as OutputClient;
    return NextResponse.json(
      await listOutputs(supabase, {
        labelId: params.get("labelId") ?? undefined,
        templateId: params.get("templateId") ?? undefined,
        status: (params.get("status") as OutputStatus) ?? undefined,
      }),
    );
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePermission(CAP.brandOutputsOperate);
  } catch (res) {
    return res as Response;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { templateKey, templateVersion, rendition } = body as {
      templateKey?: string;
      templateVersion?: number;
      rendition?: string;
    };
    if (!templateKey || !templateVersion || !rendition) {
      return NextResponse.json(
        { error: "templateKey, templateVersion and rendition are required" },
        { status: 400 },
      );
    }

    const admin = createSupabaseAdminClient();
    const template = await getTemplateVersion(
      admin as unknown as TemplateClient,
      templateKey,
      templateVersion,
    );
    if (!template) {
      return NextResponse.json({ error: "Template version not found" }, { status: 404 });
    }
    if (!template.renditions.some((r) => r.key === rendition)) {
      return NextResponse.json(
        { error: `"${rendition}" is not a rendition of ${templateKey} v${templateVersion}` },
        { status: 400 },
      );
    }

    const inputs = (body.inputs as Record<string, unknown>) ?? {};
    const [canon, season, assets] = await Promise.all([
      getCanon(),
      getActiveSeason(admin as unknown as SeasonClient),
      listAssets(admin as unknown as AssetClient),
    ]);

    const issues = validateSlotInputs(template.slots, inputs, {
      assets: assets.map((a) => ({
        id: a.id, kind: a.kind, variant: a.variant, status: a.status,
      })),
      roleNames: Object.keys(canon.roleMap?.light ?? {}),
      paletteKeys: (canon.palette ?? []).map((c) => c.key),
      season: seasonContext(season),
    });

    if (hasBlockingIssues(issues)) {
      return NextResponse.json({ error: "Validation failed", issues }, { status: 422 });
    }

    const output = await createOutput(admin as unknown as OutputClient, {
      template_id: template.id,
      template_version: template.version,
      rendition,
      inputs,
      // Resolved values, not the roleMap — the palette can move underneath a
      // pointer, so only the value records what was actually used.
      tokens_snapshot: snapshotTokens(canon),
      asset_refs: collectAssetRefs(template, inputs, season),
      season_id: season?.id ?? null,
      label_id: (body.labelId as string) ?? null,
      source: body.source === "agent" ? "agent" : "human",
    });

    // Warnings ride along so the author sees them without them blocking.
    return NextResponse.json({ ...output, issues }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
