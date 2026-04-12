/**
 * Default templates for PlaneExtras.
 *
 * The proxy template uses __PLANE_ID__ as a placeholder for the Plane
 * Helm release name — it's replaced at synth time.
 *
 * The seed script runs inside the Plane backend container via
 * `python manage.py shell -c` and creates admin / workspace / API token.
 */

// ---------------------------------------------------------------------------
// Nginx reverse proxy config
// ---------------------------------------------------------------------------

export const DEFAULT_PROXY_CONF = `server {
    listen 8081;
    client_max_body_size 20m;

    location /api/      { proxy_pass http://__PLANE_ID__-api:8000;  proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
    location /auth/     { proxy_pass http://__PLANE_ID__-api:8000;  proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
    location /live/     { proxy_pass http://__PLANE_ID__-live:3000; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
    location /spaces/   { proxy_pass http://__PLANE_ID__-space:3000; proxy_set_header Host $host; }
    location /god-mode/ { proxy_pass http://__PLANE_ID__-admin:3000; proxy_set_header Host $host; }
    location /uploads/  { proxy_pass http://__PLANE_ID__-minio:9000; proxy_set_header Host $host; }
    location /          { proxy_pass http://__PLANE_ID__-web:3000;  proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
}`;

// ---------------------------------------------------------------------------
// Admin + workspace + API-token seeder (Django management command)
// ---------------------------------------------------------------------------

export const DEFAULT_SEED_SCRIPT = `\
"""Plane CE admin + workspace + API token seeder.

Runs inside the Plane backend container via \\\`python manage.py shell -c\\\`.
Reads env vars for admin credentials, workspace config, and API token.
Skips creation of resources that already exist (idempotent).
Exits 1 if the Instance isn't ready yet (the Job will retry via backoffLimit).
"""
import os, uuid, sys
from django.utils import timezone
from django.contrib.auth.hashers import make_password
from plane.db.models import User, Profile, Workspace, WorkspaceMember, APIToken
from plane.license.models import Instance, InstanceAdmin

email = os.environ["ADMIN_EMAIL"]
password = os.environ["ADMIN_PASSWORD"]
ws_slug = os.environ.get("WORKSPACE_SLUG", "composed-booking")
ws_name = os.environ.get("WORKSPACE_NAME", "Composed Booking")
api_token = os.environ.get("PLANE_API_TOKEN", "")

# -- Instance check --
inst = Instance.objects.first()
if inst is None:
    print("Instance not ready yet, will retry.")
    sys.exit(1)

# -- Admin user --
u = User.objects.filter(email=email).first()
if u is None:
    u = User.objects.create(
        email=email,
        username=uuid.uuid4().hex,
        password=make_password(password),
        first_name="Admin",
        is_active=True,
        is_password_autoset=False,
        last_active=timezone.now(),
    )
    Profile.objects.create(user=u)
    InstanceAdmin.objects.create(user=u, instance=inst, role=20)
    inst.is_setup_done = True
    inst.save()
    print(f"Created admin {email}")
else:
    print(f"Admin {email} already exists, skipping.")

# -- Workspace --
ws = Workspace.objects.filter(slug=ws_slug).first()
if ws is None:
    ws = Workspace.objects.create(
        name=ws_name,
        slug=ws_slug,
        owner=u,
        created_by=u,
        updated_by=u,
    )
    WorkspaceMember.objects.create(
        workspace=ws,
        member=u,
        role=20,
        created_by=u,
        updated_by=u,
    )
    print(f"Created workspace '{ws_name}' (slug: {ws_slug})")
else:
    print(f"Workspace {ws_slug} already exists, skipping.")

# -- API token (for Plane MCP server) --
if api_token:
    if not APIToken.objects.filter(token=api_token).exists():
        APIToken.objects.create(
            token=api_token,
            label="pilot-agent",
            user=u,
            user_type=1,
            created_by=u,
            updated_by=u,
        )
        print("Created API token for Pilot agent")
    else:
        print("API token already exists, skipping.")
else:
    print("No PLANE_API_TOKEN set, skipping API token creation.")`;
