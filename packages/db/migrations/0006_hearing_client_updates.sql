-- LegalForgeX Track 1 (spec §3.6, §3.7, §5.4, §5.5).
-- hearings.outcome is the team's internal note; client_summary is the only hearing text a client may see.
-- Existing outcomes were written for the team, so they are never copied into client_summary.
ALTER TABLE hearings ADD COLUMN client_summary TEXT;

-- System templates: client emails use the client summary; reminders carry the last hearing's update.
UPDATE email_templates SET html_body =
 '<p>Dear {{client.name}},</p><p>Update from our office on <strong>{{matter.title}}</strong> ({{case.case_number}}), heard on {{hearing.date}}:</p><p>{{hearing.client_summary}}</p><p>The next date of hearing is <strong>{{hearing.next_date}}</strong>.</p><p>This update was entered by our office; it is not an extract of the court record.</p><p>Regards,<br>{{firm.name}}</p>'
WHERE organization_id IS NULL AND template_key = 'hearing_outcome_client';

UPDATE email_templates SET html_body =
 '<p>Dear {{client.name}},</p><p>This is a reminder that the next hearing in your matter <strong>{{matter.title}}</strong> is scheduled for <strong>{{hearing.date}}</strong>{{hearing.time_phrase}}.</p><p>Court: {{case.court}}<br>Case number: {{case.case_number}}</p><p>{{previous.client_update_phrase}}</p><p>Please contact our office if you need any clarification.</p><p>Regards,<br>{{firm.name}}</p>'
WHERE organization_id IS NULL AND template_key = 'hearing_reminder_client';

UPDATE email_templates SET html_body =
 '<p>Hi {{recipient.first_name}},</p><p><strong>{{case.case_number}}</strong> ({{matter.title}}) is listed <strong>{{hearing.date}}</strong>{{hearing.time_phrase}} at {{case.court}}{{hearing.courtroom_phrase}}.</p><p>{{previous.internal_note_phrase}}</p><p>{{previous.client_update_phrase}}</p><p><a href="{{links.hearing}}">Open the hearing</a></p>'
WHERE organization_id IS NULL AND template_key = 'hearing_reminder_internal';

INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body) VALUES
(NULL, 'hearing_today_client', 'Hearing today (client)', 'HEARING_SCHEDULED', 'client',
 'Today: your hearing for {{matter.title}}{{hearing.time_phrase}}',
 '<p>Dear {{client.name}},</p><p>Your hearing in <strong>{{matter.title}}</strong> is listed <strong>today</strong>{{hearing.time_phrase}} at {{case.court}}{{hearing.courtroom_phrase}}.</p><p>Case number: {{case.case_number}}</p><p>{{previous.client_update_phrase}}</p><p>Regards,<br>{{firm.name}}</p>',
 NULL);

-- Firms' own client-template overrides: the internal note variable becomes the client summary.
UPDATE email_templates SET
  subject_template = regexp_replace(subject_template, '\{\{\s*hearing\.outcome\s*\}\}', '{{hearing.client_summary}}', 'g'),
  html_body = regexp_replace(html_body, '\{\{\s*hearing\.outcome\s*\}\}', '{{hearing.client_summary}}', 'g'),
  text_body = regexp_replace(text_body, '\{\{\s*hearing\.outcome\s*\}\}', '{{hearing.client_summary}}', 'g')
WHERE organization_id IS NOT NULL AND audience = 'client';

-- Default automations are offered once per key (D-013). Firms already seeded have seen the original 13.
UPDATE organizations
SET settings = settings || jsonb_build_object('seededWorkflowKeys', '["hearing_7d_lead","hearing_3d_team","hearing_1d_client","hearing_morning_lead","hearing_outcome_client","task_assigned","invoice_issued","invoice_due_3d","invoice_due_today","invoice_overdue_3d","invoice_overdue_7d","invoice_overdue_15d","payment_received"]'::jsonb)
WHERE COALESCE((settings->>'defaultWorkflowsSeeded')::boolean, false);
