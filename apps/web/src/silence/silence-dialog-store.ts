import { create } from "zustand";

interface SilenceDialogState {
	isOpen: boolean;
	setOpen: (args: { isOpen: boolean }) => void;
}

export const useSilenceDialogStore = create<SilenceDialogState>()((set) => ({
	isOpen: false,
	setOpen: ({ isOpen }) => set({ isOpen }),
}));
