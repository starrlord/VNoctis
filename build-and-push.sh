#!/bin/bash
# VNoctis Manager — Build & Push to Local Registry
# Registry: docker.yourrepo.com
#
# Usage:
#   ./build-and-push.sh                    # Build and push all containers with 'latest' tag
#   ./build-and-push.sh -t v1.0.0          # Build and push with specific version tag
#   ./build-and-push.sh -s api             # Build and push only the api service
#   ./build-and-push.sh --no-push          # Build only, don't push
#   ./build-and-push.sh --no-cache         # Build without cache
#

set -e  # Exit on error

# Default values
TAG="latest"
SERVICE="all"
NO_PUSH=false
NO_CACHE=false

REGISTRY="docker.lessthanpi.com"
PROJECT_NAME="vnm"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--tag)
            TAG="$2"
            shift 2
            ;;
        -s|--service)
            SERVICE="$2"
            if [[ ! "$SERVICE" =~ ^(all|api|builder|ui)$ ]]; then
                echo "ERROR: Service must be one of: all, api, builder, ui"
                exit 1
            fi
            shift 2
            ;;
        --no-push)
            NO_PUSH=true
            shift
            ;;
        --no-cache)
            NO_CACHE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -t, --tag TAG        Tag for the images (default: latest)"
            echo "  -s, --service SVC    Service to build: all, api, builder, ui (default: all)"
            echo "  --no-push            Build only, don't push to registry"
            echo "  --no-cache           Build without using cache"
            echo "  -h, --help           Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# Color codes
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
GRAY='\033[0;90m'
WHITE='\033[0;37m'
NC='\033[0m' # No Color

# Function to print step headers
write_step() {
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
}

# Function to build an image
build_image() {
    local service=$1
    local image_name=""
    local context=""
    local dockerfile=""

    case $service in
        api)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-api"
            context="services/vnm-api"
            dockerfile="services/vnm-api/Dockerfile"
            ;;
        builder)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-builder"
            context="services/vnm-builder"
            dockerfile="services/vnm-builder/Dockerfile"
            ;;
        ui)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-ui"
            context="services/vnm-ui"
            dockerfile="services/vnm-ui/Dockerfile"
            ;;
    esac

    local full_tag="$image_name:$TAG"
    local latest_tag="$image_name:latest"

    write_step "Building $full_tag"

    local build_args=("build" "-t" "$full_tag" "-f" "$dockerfile" "$context")

    # Also tag as latest if we're using a version tag
    if [[ "$TAG" != "latest" ]]; then
        build_args+=("-t" "$latest_tag")
    fi

    if [[ "$NO_CACHE" == true ]]; then
        build_args+=("--no-cache")
    fi

    if ! docker "${build_args[@]}"; then
        echo -e "${RED}ERROR: Failed to build $full_tag${NC}"
        exit 1
    fi

    echo -e "${GREEN}✅ Built $full_tag${NC}"
}

# Function to push an image
push_image() {
    local service=$1
    local image_name=""

    case $service in
        api)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-api"
            ;;
        builder)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-builder"
            ;;
        ui)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-ui"
            ;;
    esac

    local full_tag="$image_name:$TAG"
    local latest_tag="$image_name:latest"

    write_step "Pushing $full_tag"

    if ! docker push "$full_tag"; then
        echo -e "${RED}ERROR: Failed to push $full_tag${NC}"
        exit 1
    fi

    # Also push latest tag if version-tagged
    if [[ "$TAG" != "latest" ]]; then
        echo "Pushing $latest_tag..."
        docker push "$latest_tag"
    fi

    echo -e "${GREEN}✅ Pushed $full_tag${NC}"
}

# Header
echo ""
echo -e "${MAGENTA}🎮 VNoctis Manager — Build & Push${NC}"
echo -e "${GRAY}   Registry:  $REGISTRY${NC}"
echo -e "${GRAY}   Tag:       $TAG${NC}"
echo -e "${GRAY}   Service:   $SERVICE${NC}"
echo -e "${GRAY}   No Push:   $NO_PUSH${NC}"
echo -e "${GRAY}   No Cache:  $NO_CACHE${NC}"
echo ""

# Determine which services to build
if [[ "$SERVICE" == "all" ]]; then
    services_to_build=("api" "builder" "ui")
else
    services_to_build=("$SERVICE")
fi

# Build phase
start_time=$(date +%s)

for svc in "${services_to_build[@]}"; do
    build_image "$svc"
done

# Push phase
if [[ "$NO_PUSH" != true ]]; then
    for svc in "${services_to_build[@]}"; do
        push_image "$svc"
    done
fi

end_time=$(date +%s)
elapsed=$((end_time - start_time))

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Complete! (${elapsed}s)${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

# Print the image tags for reference
echo -e "${YELLOW}Images:${NC}"
for svc in "${services_to_build[@]}"; do
    case $svc in
        api)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-api"
            ;;
        builder)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-builder"
            ;;
        ui)
            image_name="$REGISTRY/$PROJECT_NAME/vnm-ui"
            ;;
    esac
    echo -e "${WHITE}  $image_name:$TAG${NC}"
done
echo ""
