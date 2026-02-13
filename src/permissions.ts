/**
 * Permission system for bot administration.
 * If no admin role is configured, everyone can use admin commands.
 * If an admin role is set, only users with that role can use admin commands.
 */

import {
    rootServer,
    RootApiException,
    type CommunityRoleGuid,
    CommunityMemberGetRequest,
    CommunityMember,
} from "@rootsdk/server-bot";
import { ADMIN_ROLE_KEY } from "./types.js";

/**
 * Check if a user has admin permissions.
 * Returns true if no admin role is configured (everyone is admin).
 * Returns true if user has the configured admin role.
 * Returns false otherwise.
 */
export async function hasAdminPermission(userId: string): Promise<boolean> {
    const adminRoleId = await getAdminRoleId();

    // If no admin role is configured, everyone has admin permissions
    if (!adminRoleId) {
        return true;
    }

    // Check if user has the admin role
    try {
        const memberRequest: CommunityMemberGetRequest = { userId: userId as any };
        const member: CommunityMember = await rootServer.community.communityMembers.get(memberRequest);

        if (!member.communityRoleIds || member.communityRoleIds.length === 0) {
            return false;
        }

        return member.communityRoleIds.includes(adminRoleId as CommunityRoleGuid);
    } catch (err) {
        if (err instanceof RootApiException) {
            console.error("[Permissions] RootApiException checking member roles:", err.errorCode);
        } else if (err instanceof Error) {
            console.error("[Permissions] Error checking member roles:", err.message);
        } else {
            console.error("[Permissions] Unknown error checking member roles:", err);
        }
        return false;
    }
}

/**
 * Get the configured admin role ID.
 * Returns undefined if no admin role is configured.
 */
export async function getAdminRoleId(): Promise<string | undefined> {
    try {
        return await rootServer.dataStore.appData.get<string>(ADMIN_ROLE_KEY);
    } catch {
        return undefined;
    }
}

/**
 * Set the admin role ID.
 */
export async function setAdminRoleId(roleId: string): Promise<void> {
    await rootServer.dataStore.appData.set([{
        key: ADMIN_ROLE_KEY,
        value: roleId,
    }]);
}

/**
 * Clear the admin role requirement.
 */
export async function clearAdminRole(): Promise<void> {
    await rootServer.dataStore.appData.delete(ADMIN_ROLE_KEY);
}
