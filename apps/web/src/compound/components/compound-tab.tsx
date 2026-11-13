"use client";

import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import type { CompoundElement } from "@/timeline";
import { mediaTimeToSeconds } from "@/wasm";

/** Properties of a compound clip: which scene it plays, and a way into it. */
export function CompoundTab({ element }: { element: CompoundElement }) {
	const editor = useEditor();
	const scene = useEditor((e) =>
		e.scenes.getScenes().find((candidate) => candidate.id === element.sceneId),
	);

	if (!scene) {
		return (
			<p className="text-muted-foreground p-4 text-sm">
				The scene this compound clip plays was deleted, so it shows nothing.
			</p>
		);
	}

	const startSeconds = mediaTimeToSeconds({ time: element.trimStart });
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="text-sm">
				<p className="font-medium">{scene.name}</p>
				<p className="text-muted-foreground text-xs">
					Plays this scene{startSeconds > 0 ? ` from ${startSeconds.toFixed(2)}s` : ""}.
					Edit its clips by opening it; changes show up everywhere it is used.
				</p>
			</div>
			<Button
				variant="secondary"
				onClick={() => void editor.scenes.switchToScene({ sceneId: scene.id })}
			>
				Open scene
			</Button>
		</div>
	);
}
