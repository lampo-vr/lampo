// What a workspace's plan shows around the app where a billing provider runs, in one chunk after the first paint
// (billing/due.ts billingCode): the library's banner at the trial's end, grace and read-only (conversion/Ending.tsx),
// the sidebar's trial line, its card and the account menu's rows (conversion/Trial.tsx), the locked Add video's
// popover, and the moments of value — the first loop on a real video, the first review link opened
// (conversion/Value.tsx). The library and the sidebar hold their room before this arrives.
export { BillingBanner, ReadOnlyPop } from '../conversion/Ending.tsx';
export { MenuTrialCard, menuEntries, TrialLine } from '../conversion/Trial.tsx';
export { LinkOpenMoment, LoopMoment } from '../conversion/Value.tsx';
