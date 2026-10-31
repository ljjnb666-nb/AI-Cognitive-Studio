/** Only privately-created Docling worker clients may be registered.
 * Release ownership before invoking close to make shutdown idempotent.
 */
export class DoclingOwnedStorageRegistry {
  private readonly owned=new WeakMap<object,{close():void}>();
  attach(owner:object,storage:{close():void}):void {
    if(this.owned.has(owner))throw new Error("DOCLING_OWNED_STORAGE_ALREADY_ATTACHED");
    this.owned.set(owner,storage);
  }
  close(owner:object):boolean {
    const storage=this.owned.get(owner);
    if(!storage)return false;
    this.owned.delete(owner);
    storage.close();
    return true;
  }
}
