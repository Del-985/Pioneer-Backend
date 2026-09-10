export type ServiceRequestWorkflowStatus =
  | 'new'
  | 'in_review'
  | 'accepted'
  | 'denied'
  | 'scheduled'
  | 'completed'
  | 'cancelled';

export type CustomerServiceRequestStatus = 'pending' | 'accepted' | 'denied' | 'cancelled';

const transitions: Record<ServiceRequestWorkflowStatus, ServiceRequestWorkflowStatus[]> = {
  new: ['in_review', 'accepted', 'denied', 'cancelled'],
  in_review: ['accepted', 'denied', 'cancelled'],
  accepted: ['scheduled', 'completed', 'cancelled'],
  scheduled: ['completed', 'cancelled'],
  denied: [],
  completed: [],
  cancelled: [],
};

export function toCustomerServiceRequestStatus(
  status: ServiceRequestWorkflowStatus | string
): CustomerServiceRequestStatus {
  switch (status) {
    case 'new':
    case 'in_review':
      return 'pending';
    case 'accepted':
    case 'scheduled':
    case 'completed':
      return 'accepted';
    case 'denied':
      return 'denied';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export function canTransitionServiceRequest(
  from: ServiceRequestWorkflowStatus,
  to: ServiceRequestWorkflowStatus
): boolean {
  return from === to || transitions[from].includes(to);
}
