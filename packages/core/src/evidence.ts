/**
 * Evidence contributors — how other modules hand the long-horizon verifier
 * hard signals about work outside the transcript.
 *
 * Kanboard (step 4) registers one so a goal cannot complete while this
 * session still holds an In Progress claim. Contributors are time-boxed and
 * a throw counts as no contribution — evidence must never break settlement.
 */

export interface EvidenceContribution {
	blocking: string[];
	notes: string[];
}

export type EvidenceContributor = () => Promise<EvidenceContribution>;

const KEY = Symbol.for("unipi.evidence.contributors");

interface Holder {
	contributors: Map<string, EvidenceContributor>;
}

function holder(): Holder {
	const g = globalThis as { [KEY]?: Holder };
	g[KEY] ??= { contributors: new Map() };
	return g[KEY] as Holder;
}

/** Register a named contributor; re-registering a name replaces it. */
export function registerEvidenceContributor(
	name: string,
	contributor: () => Promise<EvidenceContribution>,
): () => void {
	const h = holder();
	h.contributors.set(name, contributor);
	return () => {
		const current = h.contributors.get(name);
		if (current === contributor) h.contributors.delete(name);
	};
}

/** Test/holder introspection hook. */
export function resetEvidenceForTests(): void {
	holder().contributors.clear();
}

/**
 * Gather every contribution, each time-boxed; a throw or timeout contributes
 * nothing. `blocking` items force a `not_met` verdict downstream; `notes`
 * ride the evidence brief as context.
 */
export async function gatherEvidence(timeoutMs = 2_000): Promise<EvidenceContribution> {
	const contributors = [...holder().contributors.values()];
	if (contributors.length === 0) return { blocking: [], notes: [] };
	const blocking: string[] = [];
	const notes: string[] = [];
	await Promise.all(
		contributors.map(async (contributor) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const contribution = await Promise.race([
					Promise.resolve(contributor()),
					new Promise<null>((resolve) => {
						timer = setTimeout(() => resolve(null), timeoutMs);
					}),
				]);
				if (contribution === null) return;
				blocking.push(...contribution.blocking);
				notes.push(...contribution.notes);
			} catch {
				// A failed contributor is no contribution.
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}),
	);
	return { blocking, notes };
}
