/** Runtime layer: route reading state, progress, communication and replanning triggers. */

import type {
  CodeNodeId,
  EventId,
  KnowledgeItemId,
  MessageId,
  ProjectId,
  ReadingGoal,
  RouteId,
  RouteRevisionId,
  RouteStepId,
  SessionId,
  TimestampMs,
  UserId,
  WorkspaceId,
} from './common';

export type ReadingState =
  | 'idle'
  | 'orienting'
  | 'presenting_step'
  | 'awaiting_user'
  | 'verifying'
  | 'giving_hint'
  | 'step_completed'
  | 'route_completed'
  | 'paused'
  | 'replanning'
  | 'error';

export interface ReadingSession {
  id: SessionId;
  workspace_id: WorkspaceId;
  route_id: RouteId;
  route_revision_id: RouteRevisionId;
  user_id?: UserId;
  state: ReadingState;
  current_step_id?: RouteStepId;
  started_at: TimestampMs;
  last_active_at: TimestampMs;
  completed_at?: TimestampMs;
}

export type StepStatus = 'pending' | 'in_progress' | 'understood' | 'needs_review' | 'skipped';

export interface StepProgress {
  step_id: RouteStepId;
  status: StepStatus;
  started_at?: TimestampMs;
  completed_at?: TimestampMs;
  verification_attempt_count: number;
  current_hint_level: 0 | 1 | 2 | 3 | 4;
  user_notes?: string;
}

export interface RouteProgress {
  route_id: RouteId;
  route_revision_id: RouteRevisionId;
  current_step_id?: RouteStepId;
  step_progress: Record<RouteStepId, StepProgress>;
  completed_count: number;
  total_count: number;
  started_at?: TimestampMs;
  last_active_at?: TimestampMs;
  completed_at?: TimestampMs;
}

export interface WorkspaceRuntimeSnapshot {
  workspace_id: WorkspaceId;
  active_route_id?: RouteId;
  active_session_id?: SessionId;
  route_progress: Record<RouteId, RouteProgress>;
  updated_at: TimestampMs;
}

export interface VerificationAttempt {
  id: string;
  session_id: SessionId;
  step_id: RouteStepId;
  answer: string;
  result: 'correct' | 'partial' | 'incorrect' | 'not_evaluated';
  matched_points: string[];
  missing_points: string[];
  feedback: string;
  created_at: TimestampMs;
}

export interface LearningState {
  id: string;
  project_id: ProjectId;
  workspace_id: WorkspaceId;
  user_id?: UserId;
  items: KnowledgeItem[];
  updated_at: TimestampMs;
}

export interface KnowledgeItem {
  id: KnowledgeItemId;
  target_type: 'code_node' | 'concept' | 'flow';
  target_id: CodeNodeId | string;
  label: string;
  mastery: 'introduced' | 'understood' | 'practiced' | 'needs_review';
  learned_from_route_id?: RouteId;
  learned_from_step_id?: RouteStepId;
  evidence: KnowledgeEvidence[];
  updated_at: TimestampMs;
}

export interface KnowledgeEvidence {
  type: 'user_confirmed' | 'verification_passed' | 'successful_application';
  reference_id?: string;
  description?: string;
}

export type ReadingCommand =
  | { type: 'start_route'; route_id: RouteId }
  | { type: 'open_step'; step_id: RouteStepId }
  | { type: 'submit_answer'; step_id: RouteStepId; answer: string }
  | { type: 'request_hint'; step_id: RouteStepId }
  | { type: 'skip_step'; step_id: RouteStepId; reason?: string }
  | { type: 'ask_question'; step_id?: RouteStepId; message: string }
  | { type: 'switch_route'; route_id: RouteId }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'create_branch'; request: CreateBranchRequest }
  | { type: 'create_follow_up'; request: CreateFollowUpRouteRequest };

export interface CreateBranchRequest {
  source_route_id: RouteId;
  source_step_id: RouteStepId;
  goal: ReadingGoal;
  user_reason?: string;
}

export interface CreateFollowUpRouteRequest {
  source_route_id: RouteId;
  suggestion_id?: string;
  goal: ReadingGoal;
}

export type ReadingEvent =
  | { type: 'session_started'; session_id: SessionId; route_id: RouteId }
  | { type: 'step_entered'; step_id: RouteStepId }
  | { type: 'step_content_ready'; step_id: RouteStepId }
  | { type: 'hint_unlocked'; step_id: RouteStepId; level: 1 | 2 | 3 | 4 }
  | { type: 'verification_completed'; attempt_id: string; step_id: RouteStepId }
  | { type: 'step_status_changed'; step_id: RouteStepId; status: StepStatus }
  | { type: 'route_completed'; route_id: RouteId }
  | { type: 'replanning_requested'; route_id: RouteId; reason: string }
  | { type: 'route_created'; route_id: RouteId }
  | { type: 'runtime_error'; code: string; message: string };

export interface UserMessage {
  id: MessageId;
  session_id: SessionId;
  step_id?: RouteStepId;
  content: string;
  created_at: TimestampMs;
}

export interface AgentMessage {
  id: MessageId;
  session_id: SessionId;
  step_id?: RouteStepId;
  kind: 'orientation' | 'explanation' | 'question' | 'hint' | 'feedback' | 'navigation';
  content: string;
  created_at: TimestampMs;
}

export interface RuntimeEventEnvelope {
  id: EventId;
  session_id: SessionId;
  sequence: number;
  event: ReadingEvent;
  created_at: TimestampMs;
}

export interface RuntimeCheckpoint {
  session: ReadingSession;
  workspace: WorkspaceRuntimeSnapshot;
  last_event_sequence: number;
  saved_at: TimestampMs;
}
