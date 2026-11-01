const TYPES = "feat|fix|docs|style|refactor|test|ci|chore";
const BRANCH = new RegExp(`^(${TYPES})/[a-z0-9]+(-[a-z0-9]+)*$`);
const TITLE = new RegExp(`^(${TYPES})(\\([a-z0-9-]+\\))?!?: \\S`);

const { PR_BRANCH: branch = "", PR_TITLE: title = "" } = process.env;
const errors = [];

if (!BRANCH.test(branch)) {
  errors.push(
    `Branch "${branch}" must look like feat/short-name. Types: ${TYPES}.`,
  );
}
if (!TITLE.test(title)) {
  errors.push(
    `Title "${title}" must look like "feat(mail): add labels". Types: ${TYPES}.`,
  );
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Branch and title follow the format.");
