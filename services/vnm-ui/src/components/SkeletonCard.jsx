/**
 * Skeleton loading card placeholder matching GameCard dimensions.
 * Shows an animated pulse effect while data is loading.
 */
export default function SkeletonCard() {
  return (
    <div className="flex flex-col rounded-lg overflow-hidden shadow-lg">
      {/* Image area skeleton */}
      <div className="aspect-[4/1] animate-pulse bg-gray-700 rounded-t-lg" />
      {/* Info area skeleton */}
      <div className="h-[60px] animate-pulse bg-gray-600 rounded-b-lg" />
    </div>
  );
}
