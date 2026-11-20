"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Add01Icon,
	Alert02Icon,
	Cancel01Icon,
	RotateLeft01Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ACTIONS,
	getActionDefinition,
	isActionWithOptionalArgs,
	type TActionWithOptionalArgs,
} from "@/actions";
import {
	isBrowserReservedShortcut,
	type ShortcutKey,
} from "@/actions/keybinding";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { formatKey } from "@/actions/use-keyboard-shortcuts-help";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/utils/ui";

export function ShortcutsDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[80vh] max-h-[40rem] max-w-2xl flex-col gap-0 p-0">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
				</DialogHeader>
				<ShortcutsEditor
					listClassName="scrollbar-thin min-h-0 grow overflow-y-auto px-6 py-4"
					footerClassName="border-t px-6 py-4"
				/>
			</DialogContent>
		</Dialog>
	);
}

/* ------------------------------------------------------------------ Model */

type BindableAction = {
	action: TActionWithOptionalArgs;
	description: string;
	category: string;
	defaults: readonly ShortcutKey[];
};

const BINDABLE_ACTIONS: BindableAction[] = Object.keys(ACTIONS)
	.filter(isActionWithOptionalArgs)
	.map((action) => {
		const definition = getActionDefinition({ action });
		return {
			action,
			description: definition.description,
			category: definition.category,
			defaults: definition.defaultShortcuts ?? [],
		};
	})
	.sort(
		(a, b) =>
			a.category.localeCompare(b.category) ||
			a.description.localeCompare(b.description),
	);

const DESCRIPTION_BY_ACTION = new Map(
	BINDABLE_ACTIONS.map((entry) => [entry.action, entry.description]),
);

function describeAction(action: TActionWithOptionalArgs): string {
	return DESCRIPTION_BY_ACTION.get(action) ?? action;
}

function sameKeys({
	current,
	defaults,
}: {
	current: readonly ShortcutKey[];
	defaults: readonly ShortcutKey[];
}): boolean {
	if (current.length !== defaults.length) return false;
	const set = new Set(current);
	return defaults.every((key) => set.has(key));
}

/**
 * What the editor is doing for one action: waiting for a key press, or
 * asking what to do with a key it can't bind straight away.
 * `replaceKey` is the binding being changed; null means adding a new one.
 */
type EditState =
	| {
			phase: "recording";
			action: TActionWithOptionalArgs;
			replaceKey: ShortcutKey | null;
	  }
	| {
			phase: "conflict";
			action: TActionWithOptionalArgs;
			replaceKey: ShortcutKey | null;
			key: ShortcutKey;
			existingAction: TActionWithOptionalArgs;
	  }
	| {
			phase: "reserved";
			action: TActionWithOptionalArgs;
			replaceKey: ShortcutKey | null;
			key: ShortcutKey;
	  };

/* ----------------------------------------------------------------- Editor */

/** Every bindable action with its keys, editable, plus a reset-all button. */
export function ShortcutsEditor({
	listClassName,
	footerClassName,
}: {
	listClassName?: string;
	footerClassName?: string;
}) {
	const keybindings = useKeybindingsStore((s) => s.keybindings);
	const assignKeybinding = useKeybindingsStore((s) => s.assignKeybinding);
	const removeKeybinding = useKeybindingsStore((s) => s.removeKeybinding);
	const resetActionKeybindings = useKeybindingsStore(
		(s) => s.resetActionKeybindings,
	);
	const resetToDefaults = useKeybindingsStore((s) => s.resetToDefaults);
	const getKeybindingString = useKeybindingsStore((s) => s.getKeybindingString);
	const setIsRecording = useKeybindingsStore((s) => s.setIsRecording);

	const [edit, setEdit] = useState<EditState | null>(null);
	const [query, setQuery] = useState("");
	const [confirmingResetAll, setConfirmingResetAll] = useState(false);

	const keysByAction = useMemo(() => {
		const map = new Map<TActionWithOptionalArgs, ShortcutKey[]>();
		for (const [key, action] of keybindings) {
			const list = map.get(action);
			if (list) list.push(key);
			else map.set(action, [key]);
		}
		return map;
	}, [keybindings]);

	const customizedCount = BINDABLE_ACTIONS.filter(
		(entry) =>
			!sameKeys({
				current: keysByAction.get(entry.action) ?? [],
				defaults: entry.defaults,
			}),
	).length;

	const isRecording = edit?.phase === "recording";

	// Global shortcuts stay quiet while a key is being recorded.
	useEffect(() => {
		setIsRecording(isRecording);
		return () => setIsRecording(false);
	}, [isRecording, setIsRecording]);

	// Capture on window so this runs before the dialog's own Escape handling
	// and before the editor's shortcut listener on document.
	useEffect(() => {
		if (edit?.phase !== "recording") return;
		const { action, replaceKey } = edit;

		const handleKeyDown = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopImmediatePropagation();

			const isBareEscape =
				event.key === "Escape" &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				!event.shiftKey;
			if (isBareEscape) {
				setEdit(null);
				return;
			}

			// Null while only modifiers are held: keep waiting for the key.
			const key = getKeybindingString(event);
			if (!key) return;

			if (isBrowserReservedShortcut(key)) {
				setEdit({ phase: "reserved", action, replaceKey, key });
				return;
			}

			const existingAction = keybindings.get(key);
			if (existingAction && existingAction !== action) {
				setEdit({ phase: "conflict", action, replaceKey, key, existingAction });
				return;
			}

			if (existingAction !== action || replaceKey) {
				assignKeybinding({ key, action, replaceKey });
			}
			setEdit(null);
		};

		window.addEventListener("keydown", handleKeyDown, { capture: true });
		return () =>
			window.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [edit, keybindings, getKeybindingString, assignKeybinding]);

	const handleResetAction = (entry: BindableAction) => {
		setEdit(null);
		const skipped = resetActionKeybindings(entry.action);
		if (skipped.length > 0) {
			toast.warning(`Some default keys for "${entry.description}" are in use`, {
				description: skipped
					.map((key) => {
						const owner = keybindings.get(key);
						return `${formatKey({ key })}${owner ? ` → ${describeAction(owner)}` : ""}`;
					})
					.join(", "),
			});
		}
	};

	const normalizedQuery = query.trim().toLowerCase();
	const visibleActions = normalizedQuery
		? BINDABLE_ACTIONS.filter((entry) => {
				const keys = keysByAction.get(entry.action) ?? [];
				return (
					entry.description.toLowerCase().includes(normalizedQuery) ||
					entry.category.toLowerCase().includes(normalizedQuery) ||
					keys.some((key) =>
						formatKey({ key }).toLowerCase().includes(normalizedQuery),
					)
				);
			})
		: BINDABLE_ACTIONS;
	const categories = Array.from(
		new Set(visibleActions.map((entry) => entry.category)),
	);

	return (
		<>
			<div className={cn("flex flex-col gap-4", listClassName)}>
				<div className="relative">
					<HugeiconsIcon
						icon={Search01Icon}
						className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
					/>
					<Input
						size="sm"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search shortcuts or keys"
						className="pl-8"
						aria-label="Search shortcuts"
					/>
				</div>

				{categories.length === 0 && (
					<p className="text-muted-foreground py-6 text-center text-sm">
						No shortcuts match &ldquo;{query}&rdquo;.
					</p>
				)}

				{categories.map((category) => (
					<section key={category} className="flex flex-col">
						<h3 className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
							{category}
						</h3>
						<div className="flex flex-col divide-y">
							{visibleActions
								.filter((entry) => entry.category === category)
								.map((entry) => (
									<ShortcutRow
										key={entry.action}
										entry={entry}
										keys={keysByAction.get(entry.action) ?? []}
										edit={edit?.action === entry.action ? edit : null}
										onStartRecording={(replaceKey) =>
											setEdit({
												phase: "recording",
												action: entry.action,
												replaceKey,
											})
										}
										onCancel={() => setEdit(null)}
										onRemove={(key) => {
											setEdit(null);
											removeKeybinding(key);
										}}
										onReset={() => handleResetAction(entry)}
										onConfirmReassign={({ key, replaceKey }) => {
											assignKeybinding({ key, action: entry.action, replaceKey });
											setEdit(null);
										}}
									/>
								))}
						</div>
					</section>
				))}
			</div>

			<div
				className={cn(
					"flex flex-wrap items-center justify-between gap-3",
					footerClassName,
				)}
			>
				<span className="text-muted-foreground text-xs">
					{customizedCount === 0
						? "All shortcuts are on their defaults."
						: `${customizedCount} shortcut${customizedCount === 1 ? "" : "s"} customized.`}
				</span>
				{confirmingResetAll ? (
					<div className="flex items-center gap-2">
						<span className="text-sm">Reset every shortcut?</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setConfirmingResetAll(false)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={() => {
								setEdit(null);
								resetToDefaults();
								setConfirmingResetAll(false);
								toast.success("Shortcuts reset to defaults");
							}}
						>
							Reset all
						</Button>
					</div>
				) : (
					<Button
						variant="outline"
						size="sm"
						disabled={customizedCount === 0}
						onClick={() => setConfirmingResetAll(true)}
					>
						<HugeiconsIcon icon={RotateLeft01Icon} />
						Reset all to defaults
					</Button>
				)}
			</div>
		</>
	);
}

/* -------------------------------------------------------------------- Row */

function ShortcutRow({
	entry,
	keys,
	edit,
	onStartRecording,
	onCancel,
	onRemove,
	onReset,
	onConfirmReassign,
}: {
	entry: BindableAction;
	keys: ShortcutKey[];
	edit: EditState | null;
	onStartRecording: (replaceKey: ShortcutKey | null) => void;
	onCancel: () => void;
	onRemove: (key: ShortcutKey) => void;
	onReset: () => void;
	onConfirmReassign: (params: {
		key: ShortcutKey;
		replaceKey: ShortcutKey | null;
	}) => void;
}) {
	const isCustomized = !sameKeys({ current: keys, defaults: entry.defaults });
	const recordingKey =
		edit?.phase === "recording" ? (edit.replaceKey ?? "new") : null;

	return (
		<div className="flex flex-col gap-2 py-2">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="text-sm">{entry.description}</span>
					{isCustomized && (
						<span
							className="bg-primary size-1.5 shrink-0 rounded-full"
							title="Changed from the default"
						/>
					)}
				</div>

				<div className="flex flex-wrap items-center justify-end gap-1.5">
					{keys.length === 0 && recordingKey === null && (
						<span className="text-muted-foreground text-xs italic">Not set</span>
					)}

					{keys.map((key) =>
						recordingKey === key ? (
							<RecordingChip key={key} onCancel={onCancel} />
						) : (
							<KeyChip
								key={key}
								shortcut={key}
								onEdit={() => onStartRecording(key)}
								onRemove={() => onRemove(key)}
							/>
						),
					)}

					{recordingKey === "new" ? (
						<RecordingChip onCancel={onCancel} />
					) : (
						<Button
							variant="ghost"
							size="icon"
							className="text-muted-foreground size-7"
							title="Add another shortcut"
							onClick={() => onStartRecording(null)}
						>
							<HugeiconsIcon icon={Add01Icon} />
							<span className="sr-only">Add shortcut for {entry.description}</span>
						</Button>
					)}

					<Button
						variant="ghost"
						size="icon"
						className={cn(
							"text-muted-foreground size-7",
							!isCustomized && "invisible",
						)}
						title="Reset to default"
						onClick={onReset}
						disabled={!isCustomized}
					>
						<HugeiconsIcon icon={RotateLeft01Icon} />
						<span className="sr-only">Reset {entry.description} to default</span>
					</Button>
				</div>
			</div>

			{edit?.phase === "conflict" && (
				<Notice>
					<span>
						<Kbd shortcut={edit.key} /> is already used by{" "}
						<strong className="font-medium">
							{describeAction(edit.existingAction)}
						</strong>
						. Reassign it to {entry.description}?
					</span>
					<div className="flex shrink-0 gap-2">
						<Button variant="outline" size="sm" onClick={onCancel}>
							Cancel
						</Button>
						<Button
							size="sm"
							onClick={() =>
								onConfirmReassign({ key: edit.key, replaceKey: edit.replaceKey })
							}
						>
							Reassign
						</Button>
					</div>
				</Notice>
			)}

			{edit?.phase === "reserved" && (
				<Notice>
					<span>
						<Kbd shortcut={edit.key} /> is reserved by your browser, so the
						editor never receives it. Pick a different shortcut.
					</span>
					<div className="flex shrink-0 gap-2">
						<Button variant="outline" size="sm" onClick={onCancel}>
							Cancel
						</Button>
						<Button size="sm" onClick={() => onStartRecording(edit.replaceKey)}>
							Try again
						</Button>
					</div>
				</Notice>
			)}
		</div>
	);
}

function Notice({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
			<div className="flex min-w-0 flex-1 basis-60 items-start gap-2">
				<HugeiconsIcon
					icon={Alert02Icon}
					className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
				/>
				{children}
			</div>
		</div>
	);
}

function Kbd({ shortcut }: { shortcut: ShortcutKey }) {
	const parts = formatKey({ key: shortcut }).split("+");
	return (
		<span className="inline-flex items-center gap-0.5 align-middle">
			{parts.map((part, index) => (
				<kbd
					key={`${index}-${part}`}
					className="bg-muted text-foreground rounded border px-1.5 py-px font-sans text-xs font-medium"
				>
					{part}
				</kbd>
			))}
		</span>
	);
}

function KeyChip({
	shortcut,
	onEdit,
	onRemove,
}: {
	shortcut: ShortcutKey;
	onEdit: () => void;
	onRemove: () => void;
}) {
	return (
		<span className="group bg-background hover:border-primary/60 inline-flex h-7 items-center rounded-md border">
			<button
				type="button"
				onClick={onEdit}
				title="Click to change"
				className="flex h-full cursor-pointer items-center rounded-l-md pr-1 pl-1.5"
			>
				<Kbd shortcut={shortcut} />
			</button>
			<button
				type="button"
				onClick={onRemove}
				title="Remove this shortcut"
				className="text-muted-foreground hover:text-foreground flex h-full cursor-pointer items-center rounded-r-md pr-1.5 pl-0.5"
			>
				<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
				<span className="sr-only">Remove {formatKey({ key: shortcut })}</span>
			</button>
		</span>
	);
}

function RecordingChip({ onCancel }: { onCancel: () => void }) {
	const ref = useRef<HTMLButtonElement>(null);

	// Clicking anywhere else cancels, the same as pressing Escape.
	useEffect(() => {
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node) || !ref.current?.contains(target)) {
				onCancel();
			}
		};
		window.addEventListener("pointerdown", handlePointerDown, { capture: true });
		return () =>
			window.removeEventListener("pointerdown", handlePointerDown, {
				capture: true,
			});
	}, [onCancel]);

	return (
		<button
			ref={ref}
			type="button"
			onClick={onCancel}
			className="border-primary bg-primary/10 text-primary inline-flex h-7 animate-pulse cursor-pointer items-center rounded-md border px-2 text-xs font-medium"
			title="Press Escape to cancel"
		>
			Press a key…
		</button>
	);
}
