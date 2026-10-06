// Types for png.mjs, which unit tests use too (the app icons in brand.test.ts).
export function readPng(buf: Buffer): { width: number; height: number; channels: number; data: Buffer };
export function diffPng(a: Buffer, b: Buffer, threshold?: number): { size?: string; changed: number; total: number };
