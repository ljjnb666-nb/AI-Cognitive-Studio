import { sources } from "@/lib/product";
import { LibraryView } from "@/components/library-view";

export default async function LibraryPage() {
  const items = await sources();
  return <LibraryView items={items} />;
}
