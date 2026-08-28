export interface OverviewStatsResponseDto {
  distribution: {
    totalJobs: number;
    totalPreTickets: number;
    emailSent: number;
    emailFailed: number;
    claimed: number;
    unclaimed: number;
    byTicketType: Array<{
      ticketTypeId: string;
      ticketTypeName: string;
      count: number;
      claimed: number;
    }>;
  };
  attendance?: {
    issued?: number;
    checkedIn?: number;
    cancelled?: number;
    attendanceRate?: number;
    byEvent?: Array<{
      eventId: string;
      eventName?: string;
      issued: number;
      checkedIn: number;
    }>;
    note?: string;
  };
  window: { from?: string; to?: string };
}

export interface DistributionDetailStatsResponseDto {
  job: {
    jobId: string;
    status: string;
    recipientCount: number;
    totalPreTickets: number;
  };
  progress: {
    emailSent: number;
    emailFailed: number;
    claimed: number;
    unclaimed: number;
    claimedAndCheckedIn?: number;
  };
}

export interface AttendanceStatsResponseDto {
  eventId: string;
  eventName?: string;
  issued?: number;
  checkedIn?: number;
  cancelled?: number;
  attendanceRate?: number;
  byTicketType?: Array<{
    ticketTypeId: string;
    name?: string;
    issued: number;
    checkedIn: number;
  }>;
  note?: string;
}
