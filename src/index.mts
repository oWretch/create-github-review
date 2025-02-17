import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import type { Change } from "@owretch/git-diff";

const reviewTag = `<!-- Review from ${context.action} -->`;

if (!context.payload.pull_request) {
	throw new Error("This action can only be run on pull_request events");
}
const { pull_request } = context.payload;

export default async function (changes: Set<Change>, reviewBody: string) {
	core.info("Creating a GitHub review");
	core.debug("Creating octokit client");
	const octokit = getOctokit(core.getInput("token", { required: true }));

	// Find the existing review(s), if they exists
	core.debug("Listing existing reviews on the pull request");
	const reviews = await octokit.paginate(
		octokit.rest.pulls.listReviews,
		{
			...context.repo,
			pull_number: pull_request.number,
		},
		(response) =>
			response.data
				.map((review) => {
					if (
						review !== undefined &&
						review.user?.type === "Bot" &&
						review.state === "CHANGES_REQUESTED" &&
						review.body.includes(reviewTag)
					) {
						core.debug(`Found outstanding review ID: ${review.id}`);
						return review;
					}
				})
				.filter((n) => n !== undefined),
	);
	if (reviews === undefined || reviews.length === 0) {
		core.info("No outstanding reviews found");
	}
	core.debug(`Review IDs: ${JSON.stringify(reviews.map((r) => r.id))}`);

	// Close any existing reviews
	for (const review of reviews) {
		core.debug(`Processing existing review: ${review.id}`);

		let message = "Superseeded by new review";
		let commentCloseClassifier = "OUTDATED";
		if (changes.size === 0 && review.id === reviews[reviews.length - 1].id) {
			// If we have no more changes, and we are dealing with the last review
			// set the message to indicate the review is correctly resolved
			message = "All formatting issues have been resolved";
			commentCloseClassifier = "RESOLVED";
		}

		// Resolve the review comments
		core.debug("Get the review comments");
		const oldComments = await octokit.paginate(
			octokit.rest.pulls.listCommentsForReview,
			{
				...context.repo,
				pull_number: pull_request.number,
				review_id: review.id,
			},
			(response) => response.data.map((comment) => comment),
		);
		for (const comment of oldComments) {
			core.debug(`Hide the review comment ${comment.id}`);
			await octokit.graphql(
				`
          mutation hideComment($id: ID!, $classifier: ReportedContentClassifiers!) {
            minimizeComment(input: {subjectId: $id, classifier: $classifier}) {
              clientMutationId
              minimizedComment {
                isMinimized
                minimizedReason
                viewerCanMinimize
              }
            }
          }
        `,
				{
					id: comment.node_id,
					classifier: commentCloseClassifier,
				},
			);
		}

		core.debug("Hide the review comment");
		await octokit.graphql(
			`
		    mutation hideComment($id: ID!, $classifier: ReportedContentClassifiers!) {
		      minimizeComment(input: {subjectId: $id, classifier: $classifier}) {
		        clientMutationId
		        minimizedComment {
		          isMinimized
		          minimizedReason
		          viewerCanMinimize
		        }
		      }
		    }
		  `,
			{ id: review.node_id, classifier: commentCloseClassifier },
		);

		// Dismiss the existing review as superseeded
		core.debug("Dismiss the existing review as superseeded");
		await octokit.rest.pulls.dismissReview({
			...context.repo,
			pull_number: pull_request.number,
			review_id: review.id,
			message: message,
			event: "DISMISS",
		});
	}

	// Post a new review if we have changes
	if (changes.size > 0) {
		core.debug("Creating new review");

		await octokit.rest.pulls.createReview({
			...context.repo,
			pull_number: pull_request.number,
			event: "REQUEST_CHANGES",
			...createComments(changes),
			body: `${reviewBody}\n${reviewTag}`,
		});
	}
	core.info("Review created");
}

function createComments(changes: Set<Change>): Set<ReviewComment> {
	const comments = new Set<ReviewComment>();
	for (const change of changes) {
		if (!change.toFile) {
			// @TODO: Handle deleted files
			continue;
		}

		const comment = {
			path: change.toFile.name,
			// biome-ignore lint/style/useTemplate: Number of backticks
			body: "````suggestion\n" + change.toFile.content + "````",
		} as ReviewComment;

		// `line` should be the last line number of the change for the review
		if (
			Math.max(change.fromFile?.line_count ?? 0, change.toFile.line_count) === 1
		) {
			comment.line = change.toFile.start_line;
		} else {
			comment.start_line = change.toFile.start_line;
			comment.line =
				change.toFile.start_line +
				(Math.max(change.fromFile?.line_count ?? 0, change.toFile.line_count) -
					1);
		}
		comments.add(comment);
	}

	return comments;
}

type ReviewComment = {
	path: string;
	body: string;
	line: number;
	start_line?: number;
};
