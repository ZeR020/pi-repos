import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRepoTools } from "./tools.ts";

export default function piReposExtension(pi: ExtensionAPI) {
	registerRepoTools(pi);
}
