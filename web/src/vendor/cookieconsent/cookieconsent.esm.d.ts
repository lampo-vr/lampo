// CookieConsent 3.1.0 by Orest Bida (MIT, LICENSE beside it; https://github.com/orestbida/cookieconsent): its ESM build
// and stylesheet copied unchanged from the package's dist/, the same files the website serves. Only what the app calls
// is typed here (the package's own types/index.d.ts covers all of it); the config is passed as the library documents it.

export interface UserPreferences {
  acceptType: 'all' | 'custom' | 'necessary';
  acceptedCategories: string[];
  rejectedCategories: string[];
  acceptedServices: Record<string, string[]>;
  rejectedServices: Record<string, string[]>;
}

export function run(config: Record<string, unknown>): Promise<void>;
export function show(createModal?: boolean): void;
export function hide(): void;
export function showPreferences(): void;
export function hidePreferences(): void;
export function acceptCategory(categories?: string | string[], exclusions?: string[]): void;
export function acceptService(service: string | string[], category: string): void;
export function acceptedCategory(category: string): boolean;
export function acceptedService(service: string, category: string): boolean;
export function validConsent(): boolean;
export function validCookie(name: string): boolean;
export function getUserPreferences(): UserPreferences;
export function setLanguage(lang: string, force?: boolean): Promise<boolean>;
export function eraseCookies(cookies: string | RegExp | (string | RegExp)[], path?: string, domain?: string): void;
export function reset(deleteCookie?: boolean): void;
