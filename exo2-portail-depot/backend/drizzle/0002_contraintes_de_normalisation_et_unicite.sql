ALTER TABLE "security"."lawyer_login_failure_by_account" DROP CONSTRAINT "lawyer_login_failure_by_account_email_is_normalized";--> statement-breakpoint
DROP INDEX "auth"."account_provider_id_account_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "auth"."account" USING btree ("providerId","accountId");--> statement-breakpoint
ALTER TABLE "auth"."user" ADD CONSTRAINT "user_email_is_normalized" CHECK ("auth"."user"."email" = lower("auth"."user"."email")
      AND "auth"."user"."email" ~ '^[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+@[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\.[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$'
      AND length("auth"."user"."email") <= 254);--> statement-breakpoint
ALTER TABLE "security"."lawyer_login_failure_by_account" ADD CONSTRAINT "lawyer_login_failure_by_account_attempts_is_not_negative" CHECK ("security"."lawyer_login_failure_by_account"."consecutive_failed_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "security"."lawyer_login_failure_by_account" ADD CONSTRAINT "lawyer_login_failure_by_account_email_is_normalized" CHECK ("security"."lawyer_login_failure_by_account"."email" = lower("security"."lawyer_login_failure_by_account"."email")
        AND "security"."lawyer_login_failure_by_account"."email" ~ '^[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+@[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\.[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$'
        AND length("security"."lawyer_login_failure_by_account"."email") <= 254);