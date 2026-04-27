// FILE: lib/utils.ts
// Purpose: Shared className merge helper used by shadcn components.
// Layer: Utility
// Exports: cn

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
