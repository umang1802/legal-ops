-- "Hearing added" emails: one to the client, one to the matter team, sent when a hearing is added.
-- The matching default automations are offered to every firm once (D-013); a firm can switch either off in Automations.
INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body) VALUES
(NULL, 'hearing_added_client', 'Hearing added (client)', 'HEARING_SCHEDULED', 'client',
 'Hearing scheduled: {{matter.title}} on {{hearing.date}}',
 '<p>Dear {{client.name}},</p><p>A hearing in your matter <strong>{{matter.title}}</strong> has been scheduled for <strong>{{hearing.date}}</strong>{{hearing.time_phrase}}.</p><p>Court: {{case.court}}{{hearing.courtroom_phrase}}<br>Case number: {{case.case_number}}</p><p>{{hearing.type_phrase}}</p><p>We will remind you closer to the date. Please contact our office if you need any clarification.</p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'hearing_added_internal', 'Hearing added (team)', 'HEARING_SCHEDULED', 'internal',
 'New hearing: {{case.case_number}} ({{matter.title}}) on {{hearing.date}}',
 '<p>Hi {{recipient.first_name}},</p><p>A hearing was added for <strong>{{case.case_number}}</strong> ({{matter.title}}): <strong>{{hearing.date}}</strong>{{hearing.time_phrase}} at {{case.court}}{{hearing.courtroom_phrase}}.</p><p>{{hearing.type_phrase}}</p><p><a href="{{links.hearing}}">Open the hearing</a></p>',
 NULL);
