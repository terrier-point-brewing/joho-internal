import { squarePostAll, squareLocationId } from "./client";

export interface SquareTeamMember {
  id: string;
  given_name: string;
  family_name: string;
  email_address?: string;
  status: "ACTIVE" | "INACTIVE";
}

/**
 * Returns all ACTIVE team members at the default location via
 * POST /v2/team-members/search (paginated).
 */
export async function fetchActiveTeamMembers(): Promise<SquareTeamMember[]> {
  return squarePostAll<SquareTeamMember>(
    "/team-members/search",
    "team_members",
    {
      query: {
        filter: {
          location_ids: [squareLocationId()],
          status: "ACTIVE",
        },
      },
    }
  );
}
