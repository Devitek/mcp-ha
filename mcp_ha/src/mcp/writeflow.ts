import { audit } from "../logger.js";
import { entityWriteAllowed, needsConfirmation, serviceAllowed } from "../safety.js";
import { CONFIRM_TTL_SECONDS, ConfirmationStore } from "../confirm.js";
import type { ToolContext } from "../context.js";

export interface WriteTarget {
  entity_id?: string | string[] | undefined;
  device_id?: string | string[] | undefined;
  area_id?: string | string[] | undefined;
}

export interface WriteRequest {
  /** Tool name, for the audit trail. */
  tool: string;
  domain: string;
  service: string;
  target?: WriteTarget | undefined;
  data?: Record<string, unknown> | undefined;
  dry_run?: boolean | undefined;
  confirm_token?: string | undefined;
  return_response?: boolean | undefined;
}

/**
 * The single write path shared by every write tool (v0.2, issue #15): the
 * service denylist, the entity allow/deny lists, the area/device bypass
 * guard, the dry run preview, the two-step confirmation for sensitive
 * domains and the audit trail all live here exactly once, so the four write
 * tools can never diverge on safety (audit B12 lesson).
 */
export async function guardedServiceCall(ctx: ToolContext, req: WriteRequest): Promise<Record<string, unknown>> {
  const dom = req.domain.toLowerCase().trim();
  const svc = req.service.toLowerCase().trim();
  const { cfg } = ctx;
  const client = ctx.client ?? "default";

  const deny = (reason: string): never => {
    audit({ client, tool: req.tool, domain: dom, service: svc, target: req.target, allowed: false, reason });
    throw new Error(`call refused: ${reason}`);
  };

  const sv = serviceAllowed(cfg, dom, svc);
  if (!sv.allowed) deny(sv.reason ?? "service denied");

  // Explicitly targeted entities (target, plus data just in case).
  const ids: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") ids.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") ids.push(x);
  };
  collect(req.target?.entity_id);
  collect(req.data?.entity_id);

  for (const id of ids) {
    const v = entityWriteAllowed(cfg, id);
    if (!v.allowed) deny(v.reason ?? `entity denied: ${id}`);
  }

  // Targeting by area or device would bypass the entity lists: refuse it as
  // soon as any entity restriction is configured.
  const hasRestrictions = cfg.entityAllowlist.length > 0 || cfg.entityDenylist.length > 0;
  if (hasRestrictions && (req.target?.area_id || req.target?.device_id)) {
    deny("entity restrictions are configured, target explicit entity_id values instead of area_id or device_id");
  }

  const wouldCall = { domain: dom, service: svc, target: req.target ?? null, data: req.data ?? null };

  if (req.dry_run) {
    audit({ client, tool: req.tool, domain: dom, service: svc, target: req.target, data: req.data, dry_run: true, allowed: true });
    return {
      dry_run: true,
      would_call: wouldCall,
      note: "Nothing was executed. Call again without dry_run to execute.",
    };
  }

  // Two-step confirmation on sensitive domains: the first call returns a
  // single-use token bound to this exact call; executing requires it. In a
  // session with an elicitation-capable client (#90), the human is asked
  // in-protocol instead; the token flow stays the universal fallback.
  if (needsConfirmation(cfg, dom)) {
    const hash = ConfirmationStore.fingerprint({ domain: dom, service: svc, target: req.target, data: req.data });
    if (!req.confirm_token) {
      const answer = ctx.elicit
        ? await ctx.elicit(
            `Sensitive action: ${dom}.${svc} on ${JSON.stringify(req.target ?? {})}` +
              `${req.data ? ` with ${JSON.stringify(req.data)}` : ""}. Confirm?`
          )
        : null;
      if (answer === false) deny("declined by the user (elicitation)");
      if (answer === null) {
        const token = ctx.confirmations.issue(hash);
        audit({ client, tool: req.tool, domain: dom, service: svc, target: req.target, allowed: true, confirmation_required: true });
        return {
          confirmation_required: true,
          confirm_token: token,
          expires_in_seconds: CONFIRM_TTL_SECONDS,
          would_call: wouldCall,
          note:
            `The ${dom} domain requires an explicit confirmation. Show this preview to the user, ` +
            "then call the SAME tool with the SAME arguments plus confirm_token to execute. The token is single use.",
        };
      }
      audit({ client, tool: req.tool, domain: dom, service: svc, target: req.target, allowed: true, confirmed_via: "elicitation" });
    } else {
      const verdict = ctx.confirmations.consume(req.confirm_token, hash);
      if (verdict !== "ok") deny(`confirmation ${verdict} (request a fresh token by calling without confirm_token)`);
    }
  }

  const payload: Record<string, unknown> = { domain: dom, service: svc };
  if (req.target) payload.target = req.target;
  if (req.data) payload.service_data = req.data;
  if (req.return_response) payload.return_response = true;

  const result = await ctx.ws.send("call_service", payload);
  audit({ client, tool: req.tool, domain: dom, service: svc, target: req.target, data: req.data, allowed: true, result: "ok" });
  return {
    success: true,
    ...(result?.response !== undefined ? { response: result.response } : {}),
  };
}
