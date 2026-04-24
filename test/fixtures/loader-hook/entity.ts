import "reflect-metadata";

function Col(): PropertyDecorator {
  return () => {};
}

export class Item {
  @Col()
  id: number = 0;

  @Col()
  name: string = "";
}

const idType = Reflect.getMetadata("design:type", Item.prototype, "id");
const nameType = Reflect.getMetadata("design:type", Item.prototype, "name");
console.log("ENTITY:id=" + idType?.name + ",name=" + nameType?.name);
