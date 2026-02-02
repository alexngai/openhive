#!/bin/bash
# OpenHive Cloud Run Deployment Script
#
# This script deploys OpenHive to Google Cloud Run with minimal configuration.
#
# Prerequisites:
#   - Google Cloud SDK installed (gcloud)
#   - Authenticated: gcloud auth login
#   - Project set: gcloud config set project YOUR_PROJECT_ID
#
# Usage:
#   ./deploy/cloud-run.sh
#   ./deploy/cloud-run.sh --region us-east1
#   OPENHIVE_ADMIN_KEY=secret ./deploy/cloud-run.sh

set -e

# Configuration
SERVICE_NAME="${SERVICE_NAME:-openhive}"
REGION="${REGION:-us-central1}"
MEMORY="${MEMORY:-512Mi}"
CPU="${CPU:-1}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --region)
      REGION="$2"
      shift 2
      ;;
    --name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "🐝 Deploying OpenHive to Cloud Run"
echo "   Service: $SERVICE_NAME"
echo "   Region:  $REGION"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "❌ gcloud CLI not found. Install from: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Get current project
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJECT_ID" ]; then
  echo "❌ No project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi
echo "   Project: $PROJECT_ID"
echo ""

# Enable required APIs
echo "📦 Enabling required APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com --quiet

# Build environment variables string
ENV_VARS="NODE_ENV=production,OPENHIVE_PORT=8080,OPENHIVE_HOST=0.0.0.0"
if [ -n "$OPENHIVE_ADMIN_KEY" ]; then
  ENV_VARS="$ENV_VARS,OPENHIVE_ADMIN_KEY=$OPENHIVE_ADMIN_KEY"
fi
if [ -n "$OPENHIVE_JWT_SECRET" ]; then
  ENV_VARS="$ENV_VARS,OPENHIVE_JWT_SECRET=$OPENHIVE_JWT_SECRET"
fi
if [ -n "$OPENHIVE_INSTANCE_NAME" ]; then
  ENV_VARS="$ENV_VARS,OPENHIVE_INSTANCE_NAME=$OPENHIVE_INSTANCE_NAME"
fi

# Deploy directly from source
echo "🚀 Deploying to Cloud Run (this may take a few minutes)..."
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --min-instances 0 \
  --max-instances 1 \
  --port 8080 \
  --set-env-vars "$ENV_VARS"

# Get the service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format 'value(status.url)')

echo ""
echo "✅ Deployment complete!"
echo ""
echo "🌐 Service URL: $SERVICE_URL"
echo "📖 API docs:    $SERVICE_URL/skill.md"
echo "🔧 Admin panel: $SERVICE_URL/admin"
echo ""
echo "⚠️  Note: Cloud Run instances are ephemeral. Data will be lost when"
echo "    the instance scales down. For persistent data, consider:"
echo "    - Fly.io or Render (recommended for SQLite)"
echo "    - Cloud SQL with PostgreSQL"
echo "    - Turso (SQLite-compatible serverless database)"
