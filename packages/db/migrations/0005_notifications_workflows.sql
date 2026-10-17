-- Phase 5: notifications for people who aren't users yet (invitees), worker indexes, system templates.

ALTER TABLE notifications DROP CONSTRAINT notifications_recipient_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_type_check CHECK (recipient_type IN ('client', 'user', 'external'));
ALTER TABLE notifications ADD CONSTRAINT notifications_external_has_destination CHECK (recipient_type <> 'external' OR destination IS NOT NULL);
ALTER TABLE notifications ADD COLUMN workflow_id UUID REFERENCES workflows(id);
ALTER TABLE notifications ADD COLUMN task_id UUID;
ALTER TABLE notifications ADD COLUMN payment_id UUID;
ALTER TABLE notifications ADD COLUMN next_attempt_at TIMESTAMPTZ;

-- Worker: due notifications to send, and stuck ones to recover.
CREATE INDEX idx_notifications_due ON notifications (scheduled_at) WHERE status = 'queued';
CREATE INDEX idx_notifications_sending ON notifications (updated_at) WHERE status = 'sending';
CREATE INDEX idx_notifications_org_approval ON notifications (organization_id, created_at DESC) WHERE status = 'awaiting_approval';
CREATE INDEX idx_scheduled_actions_running ON scheduled_actions (updated_at) WHERE status IN ('queued', 'running');
CREATE INDEX idx_outbox_processing ON outbox_events (locked_at) WHERE status = 'processing';

-- System email templates (organization_id NULL). Firms override by creating a row with the same template_key.
-- Variables use {{path}} and are HTML-escaped at render time; bodies are sanitised on save.
INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body) VALUES
(NULL, 'hearing_reminder_client', 'Hearing reminder (client)', 'HEARING_SCHEDULED', 'client',
 'Reminder: your hearing for {{matter.title}} is on {{hearing.date}}',
 '<p>Dear {{client.name}},</p><p>This is a reminder that the next hearing in your matter <strong>{{matter.title}}</strong> is scheduled for <strong>{{hearing.date}}</strong>{{hearing.time_phrase}}.</p><p>Court: {{case.court}}<br>Case number: {{case.case_number}}</p><p>Please contact our office if you need any clarification.</p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'hearing_reminder_internal', 'Hearing reminder (team)', 'HEARING_SCHEDULED', 'internal',
 '{{hearing.when}}: {{case.case_number}} ({{matter.title}})',
 '<p>Hi {{recipient.first_name}},</p><p><strong>{{case.case_number}}</strong> ({{matter.title}}) is listed <strong>{{hearing.date}}</strong>{{hearing.time_phrase}} at {{case.court}}{{hearing.courtroom_phrase}}.</p><p><a href="{{links.hearing}}">Open the hearing</a></p>',
 NULL),
(NULL, 'hearing_outcome_client', 'Case update after hearing (client)', 'HEARING_COMPLETED', 'client',
 'Case update: {{matter.title}}',
 '<p>Dear {{client.name}},</p><p>Update from our office on <strong>{{matter.title}}</strong> ({{case.case_number}}), heard on {{hearing.date}}:</p><p>{{hearing.outcome}}</p><p>The next date of hearing is <strong>{{hearing.next_date}}</strong>.</p><p>This update was entered by our office; it is not an extract of the court record.</p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'invoice_issued', 'Invoice issued (client)', 'INVOICE_CREATED', 'client',
 'Invoice {{invoice.number}} from {{firm.name}}: {{invoice.total}}',
 '<p>Dear {{client.name}},</p><p>Please find our invoice <strong>{{invoice.number}}</strong> for <strong>{{matter.title}}</strong>.</p><p>Amount: <strong>{{invoice.total}}</strong><br>Due by: <strong>{{invoice.due_date}}</strong></p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'invoice_reminder', 'Payment reminder (client)', 'INVOICE_CREATED', 'client',
 'Payment {{invoice.reminder_phrase}}: {{invoice.number}} ({{invoice.amount_due}})',
 '<p>Dear {{client.name}},</p><p>This is a reminder that <strong>{{invoice.amount_due}}</strong> on invoice <strong>{{invoice.number}}</strong> for {{matter.title}} is {{invoice.reminder_phrase}} (due date {{invoice.due_date}}).</p><p>If you have already paid, please ignore this message or send us the payment reference.</p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'invoice_escalation_internal', 'Overdue invoice escalation (team)', 'INVOICE_CREATED', 'internal',
 'Overdue {{invoice.days_overdue}} days: {{invoice.number}} ({{client.name}}, {{invoice.amount_due}})',
 '<p>Hi {{recipient.first_name}},</p><p>Invoice <strong>{{invoice.number}}</strong> for {{client.name}} ({{matter.title}}) is overdue by {{invoice.days_overdue}} days. Outstanding: <strong>{{invoice.amount_due}}</strong>.</p><p><a href="{{links.invoice}}">Open the invoice</a></p>',
 NULL),
(NULL, 'payment_received', 'Payment received (client)', 'PAYMENT_RECEIVED', 'client',
 'Payment received: {{payment.receipt_number}}',
 '<p>Dear {{client.name}},</p><p>We have received <strong>{{payment.amount}}</strong> on {{payment.date}} (receipt {{payment.receipt_number}}). Thank you.</p><p>{{payment.balance_phrase}}</p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'task_assigned', 'Task assigned (team)', 'TASK_CREATED', 'internal',
 'New task: {{task.title}}',
 '<p>Hi {{recipient.first_name}},</p><p>You have a new task{{task.matter_phrase}}: <strong>{{task.title}}</strong>{{task.due_phrase}}.</p><p><a href="{{links.task}}">Open the task</a></p>',
 NULL),
(NULL, 'client_update', 'Client update (manual)', NULL, 'client',
 'Update on {{matter.title}}',
 '<p>Dear {{client.name}},</p><p>{{custom.note}}</p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'member_invite', 'Team invitation', 'MEMBER_INVITED', 'internal',
 '{{firm.name}} invited you to LegalOps',
 '<p>Hello,</p><p>{{firm.name}} has invited you to join their workspace on LegalOps as <strong>{{invite.role}}</strong>.</p><p><a href="{{links.accept_invite}}">Accept the invitation</a> (the link expires in 7 days).</p>',
 NULL),
(NULL, 'password_reset', 'Password reset', 'PASSWORD_RESET_REQUESTED', 'internal',
 'Reset your LegalOps password',
 '<p>Hi {{recipient.first_name}},</p><p>Use the link below to choose a new password. It expires in 1 hour and works once.</p><p><a href="{{links.reset_password}}">Reset password</a></p><p>If you didn’t ask for this, you can ignore this email.</p>',
 NULL);
