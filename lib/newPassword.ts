// What a new password ends, wherever it is set: Profile, an admin, a reset link, `lampo admin reset-password`. The
// sessions end with the account's epoch (lib/auth.ts updateUser) and the links it had with voidLinks; what lives on
// elsewhere is ended here — whoever had the old password may have left one of these behind, and each would outlast it.
import { revokeAppsOf, voidCodesOf } from './oauth/store.ts';
import { forgetDevicesOf } from './push/index.ts';

/**
 * The account's devices stop getting notifications (they carry note texts to lock screens), and the apps connected
 * through OAuth stop working — with the authorization codes not yet redeemed, which would otherwise become fresh
 * connections after the change (VA-4). API tokens stay unless the caller ends them (a reset does).
 */
export function afterNewPassword(userId: string): void {
  forgetDevicesOf(userId);
  voidCodesOf(userId);
  revokeAppsOf(userId, 'password changed');
}
