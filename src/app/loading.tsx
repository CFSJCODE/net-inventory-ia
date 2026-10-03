import Image from "next/image";

export default function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center py-24">
      <Image
        src="/logo.png"
        alt="Carregando"
        width={56}
        height={56}
        className="animate-pulse"
        priority
      />
    </div>
  );
}
