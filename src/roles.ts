/**
 * Automatic role assignment on join (inspired by FBK Auto-Roles).
 */

import {
  rootServer,
  RootApiException,
  type CommunityRoleGuid,
  CommunityEvent,
  CommunityJoinedEvent,
  CommunityMemberRoleAddRequest,
} from "@rootsdk/server-bot";
import type { RootBotSettings } from "./types.js";

export function registerAutoRole(settings: RootBotSettings): void {
  rootServer.community.communities.on(
    CommunityEvent.CommunityJoined,
    (evt: CommunityJoinedEvent) => onMemberJoined(evt, settings)
  );
}

async function onMemberJoined(
  evt: CommunityJoinedEvent,
  settings: RootBotSettings
): Promise<void> {
  const roleId = await rootServer.dataStore.appData.get<string>("config:defaultRoleId");
  if (!roleId) return;

  try {
    const request: CommunityMemberRoleAddRequest = {
      communityRoleId: roleId as CommunityRoleGuid,
      userIds: [evt.userId],
    };
    await rootServer.community.communityMemberRoles.add(request);
  } catch (xcpt: unknown) {
    if (xcpt instanceof RootApiException) {
      console.error("[AutoRole] RootApiException:", xcpt.errorCode);
    } else if (xcpt instanceof Error) {
      console.error("[AutoRole] Unexpected error:", xcpt.message);
    } else {
      console.error("[AutoRole] Unknown error:", xcpt);
    }
  }
}
