import "reflect-metadata";

function Col(): PropertyDecorator {
  return () => {};
}

export class MtsItem {
  @Col()
  n: number = 0;
}

const t = Reflect.getMetadata("design:type", MtsItem.prototype, "n");
console.log("MTS:n=" + t?.name);
