// Tag now: ask the server to suggest frontmatter properties for a note and
// write them into the note. The server does not keep the note. Not exposed in
// the interface yet; the server endpoint is still planned.

/** Properties to set, as the server returns them: already normalised. */
export type PropertyPatch = Record<string, unknown>;

export interface PropertySuggester {
	suggest(markdown: string): Promise<PropertyPatch>;
}

/**
 * A stand-in until the server offers suggestions: proposes the note's
 * inline #tags as `tags`, so the flow can be built and tested end to end.
 */
export class FakePropertySuggester implements PropertySuggester {
	readonly requests: string[] = [];

	suggest(markdown: string): Promise<PropertyPatch> {
		this.requests.push(markdown);
		const tags = new Set<string>();
		for (const match of markdown.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
			const tag = match[1];
			if (tag !== undefined && !/^\d+$/.test(tag)) {
				tags.add(tag.toLowerCase());
			}
		}
		return Promise.resolve(tags.size > 0 ? { tags: [...tags].sort() } : {});
	}
}

/**
 * Applies a patch to a note's frontmatter. Tags are added to the ones
 * already there; other properties are only set when the note has none.
 * Returns the names of the properties that changed.
 */
export function applyPropertyPatch(frontmatter: Record<string, unknown>, patch: PropertyPatch): string[] {
	const changed: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		if (key === 'tags') {
			const existing = asList(frontmatter['tags']);
			const added = asList(value).filter((tag) => !existing.includes(tag));
			if (added.length > 0) {
				frontmatter['tags'] = [...existing, ...added];
				changed.push(key);
			}
		} else if (frontmatter[key] === undefined || frontmatter[key] === null || frontmatter[key] === '') {
			frontmatter[key] = value;
			changed.push(key);
		}
	}
	return changed;
}

function asList(value: unknown): string[] {
	if (typeof value === 'string') {
		return value
			.split(/[,\s]+/)
			.map((tag) => tag.replace(/^#/, ''))
			.filter((tag) => tag !== '');
	}
	if (Array.isArray(value)) {
		return value.filter((tag): tag is string => typeof tag === 'string' && tag !== '');
	}
	return [];
}

/** Writes frontmatter through the app, which keeps the rest of the note as it is. */
export type FrontmatterWriter = (
	path: string,
	update: (frontmatter: Record<string, unknown>) => void,
) => Promise<void>;

/** Suggests properties for a note and writes them. Returns the changed property names. */
export async function tagNow(
	path: string,
	markdown: string,
	suggester: PropertySuggester,
	write: FrontmatterWriter,
): Promise<string[]> {
	const patch = await suggester.suggest(markdown);
	let changed: string[] = [];
	if (Object.keys(patch).length > 0) {
		await write(path, (frontmatter) => {
			changed = applyPropertyPatch(frontmatter, patch);
		});
	}
	return changed;
}
