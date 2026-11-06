/**
 * Lógica pura de aplicación de propuestas MCL (testeable, sin Firestore ni efectos).
 * La usa scripts/ops/mcl_sync.ts y la testea scripts/ops/test_mcl_proposal.ts.
 */

/** Aplica (en memoria) los diffs de UNA propuesta; conflicto si el campo cambió. */
export function applyProposalToSessions(
    sessions: any,
    diffs: Array<{ session: string; field: string; current: any; proposed: number }>,
): { ok: true; sessions: any } | { ok: false; conflict: string } {
    const next = JSON.parse(JSON.stringify(sessions || {}));
    for (const d of diffs) {
        const cur = next?.[d.session]?.[d.field];
        const curN = cur === undefined || cur === null ? null : Number(cur);
        const expN = d.current === undefined || d.current === null ? null : Number(d.current);
        if (curN !== expN) return { ok: false, conflict: `${d.session}.${d.field}: esperado ${expN} pero actual ${curN}` };
        next[d.session] = { ...(next[d.session] || {}), [d.field]: Number(d.proposed) };
    }
    return { ok: true, sessions: next };
}

