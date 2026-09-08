CREATE INDEX "account_user_id_idx" ON "auth"."account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "account_provider_id_account_id_idx" ON "auth"."account" USING btree ("providerId","accountId");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "security"."lawyer_login_failure_by_account" ADD CONSTRAINT "lawyer_login_failure_by_account_email_is_normalized" CHECK ("security"."lawyer_login_failure_by_account"."email" = lower(btrim("security"."lawyer_login_failure_by_account"."email")) AND length("security"."lawyer_login_failure_by_account"."email") <= 254);