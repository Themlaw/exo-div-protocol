CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE SCHEMA "security";
--> statement-breakpoint
CREATE SCHEMA "deposit";
--> statement-breakpoint
CREATE TYPE "security"."authentication_failure_kind" AS ENUM('lawyer_login', 'client_pin');--> statement-breakpoint
CREATE TYPE "deposit"."access_link_status" AS ENUM('active', 'blocked', 'revoked');--> statement-breakpoint
CREATE TYPE "deposit"."deposit_request_status" AS ENUM('incomplete', 'processing', 'validated', 'blocked', 'expired_incomplete');--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"password" text,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_email_is_normalized" CHECK ("auth"."user"."email" = lower("auth"."user"."email")
      AND "auth"."user"."email" ~ '^[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+@[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\.[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$'
      AND length("auth"."user"."email") <= 254)
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security"."authentication_failure_by_ip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_ip" "inet" NOT NULL,
	"failure_kind" "security"."authentication_failure_kind" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security"."lawyer_login_failure_by_account" (
	"email" text PRIMARY KEY NOT NULL,
	"consecutive_failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lawyer_login_failure_by_account_email_is_normalized" CHECK ("security"."lawyer_login_failure_by_account"."email" = lower("security"."lawyer_login_failure_by_account"."email")
        AND "security"."lawyer_login_failure_by_account"."email" ~ '^[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+@[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\.[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$'
        AND length("security"."lawyer_login_failure_by_account"."email") <= 254),
	CONSTRAINT "lawyer_login_failure_by_account_attempts_is_not_negative" CHECK ("security"."lawyer_login_failure_by_account"."consecutive_failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security"."lawyer_login_failure_by_account_and_ip" (
	"email" text NOT NULL,
	"client_ip" "inet" NOT NULL,
	"consecutive_failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lawyer_login_failure_by_account_and_ip_email_client_ip_pk" PRIMARY KEY("email","client_ip"),
	CONSTRAINT "lawyer_login_failure_by_account_and_ip_email_is_normalized" CHECK ("security"."lawyer_login_failure_by_account_and_ip"."email" = lower("security"."lawyer_login_failure_by_account_and_ip"."email")
        AND "security"."lawyer_login_failure_by_account_and_ip"."email" ~ '^[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+@[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\.[^@[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$'
        AND length("security"."lawyer_login_failure_by_account_and_ip"."email") <= 254),
	CONSTRAINT "lawyer_login_failure_by_account_and_ip_attempts_is_not_negative" CHECK ("security"."lawyer_login_failure_by_account_and_ip"."consecutive_failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "deposit"."access_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_request_id" uuid NOT NULL,
	"token_hmac" text NOT NULL,
	"token_pepper_version" integer NOT NULL,
	"pin_hash" text NOT NULL,
	"pin_length" integer NOT NULL,
	"max_pin_attempts" integer NOT NULL,
	"failed_pin_attempts" integer DEFAULT 0 NOT NULL,
	"status" "deposit"."access_link_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "access_link_failed_attempts_within_bounds" CHECK ("deposit"."access_link"."failed_pin_attempts" BETWEEN 0 AND "deposit"."access_link"."max_pin_attempts"),
	CONSTRAINT "access_link_security_policy_within_bounds" CHECK ("deposit"."access_link"."max_pin_attempts" BETWEEN 5 AND 20
        AND "deposit"."access_link"."pin_length" BETWEEN 4 AND 12),
	CONSTRAINT "access_link_expires_after_creation" CHECK ("deposit"."access_link"."expires_at" > "deposit"."access_link"."created_at"),
	CONSTRAINT "access_link_terminal_status_is_dated" CHECK (("deposit"."access_link"."status" <> 'blocked' OR "deposit"."access_link"."blocked_at" IS NOT NULL)
        AND ("deposit"."access_link"."status" <> 'revoked' OR "deposit"."access_link"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "deposit"."deposit_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"status" "deposit"."deposit_request_status" DEFAULT 'incomplete' NOT NULL,
	"max_pin_attempts" integer NOT NULL,
	"link_lifetime_days" integer NOT NULL,
	"pin_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_request_security_policy_within_bounds" CHECK ("deposit"."deposit_request"."max_pin_attempts" BETWEEN 5 AND 20
        AND "deposit"."deposit_request"."link_lifetime_days" BETWEEN 1 AND 14
        AND "deposit"."deposit_request"."pin_length" BETWEEN 4 AND 12),
	CONSTRAINT "deposit_request_title_is_not_blank" CHECK (btrim("deposit"."deposit_request"."title") <> '')
);
--> statement-breakpoint
CREATE TABLE "deposit"."expected_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_request_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"allowed_mime_types" text[] NOT NULL,
	"max_size_bytes" integer NOT NULL,
	CONSTRAINT "expected_document_label_is_not_blank" CHECK (btrim("deposit"."expected_document"."label") <> ''),
	CONSTRAINT "expected_document_position_is_not_negative" CHECK ("deposit"."expected_document"."position" >= 0),
	CONSTRAINT "expected_document_allowed_mime_types_is_not_empty" CHECK (array_length("deposit"."expected_document"."allowed_mime_types", 1) >= 1),
	CONSTRAINT "expected_document_max_size_within_bounds" CHECK ("deposit"."expected_document"."max_size_bytes" BETWEEN 1024 AND 20971520)
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit"."access_link" ADD CONSTRAINT "access_link_deposit_request_id_deposit_request_id_fk" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit"."deposit_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit"."deposit_request" ADD CONSTRAINT "deposit_request_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit"."expected_document" ADD CONSTRAINT "expected_document_deposit_request_id_deposit_request_id_fk" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit"."deposit_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "auth"."account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "auth"."account" USING btree ("providerId","accountId");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "authentication_failure_by_ip_window_idx" ON "security"."authentication_failure_by_ip" USING btree ("client_ip","failure_kind","occurred_at");--> statement-breakpoint
CREATE INDEX "authentication_failure_by_ip_occurred_at_idx" ON "security"."authentication_failure_by_ip" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "lawyer_login_failure_by_account_and_ip_last_failed_at_idx" ON "security"."lawyer_login_failure_by_account_and_ip" USING btree ("last_failed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "access_link_token_hmac_key" ON "deposit"."access_link" USING btree ("token_hmac");--> statement-breakpoint
CREATE UNIQUE INDEX "access_link_one_active_per_request_idx" ON "deposit"."access_link" USING btree ("deposit_request_id") WHERE "deposit"."access_link"."status" = 'active';--> statement-breakpoint
CREATE INDEX "access_link_deposit_request_id_idx" ON "deposit"."access_link" USING btree ("deposit_request_id","created_at");--> statement-breakpoint
CREATE INDEX "deposit_request_owner_user_id_idx" ON "deposit"."deposit_request" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "expected_document_deposit_request_id_idx" ON "deposit"."expected_document" USING btree ("deposit_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expected_document_position_within_request_idx" ON "deposit"."expected_document" USING btree ("deposit_request_id","position");